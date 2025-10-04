const express = require('express');
const http = require('http');
const fs = require('fs');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const mysql = require('mysql2'); // Vẫn cần cho serverless-mysql
const serverlessMysql = require('serverless-mysql');
const bcrypt = require('bcryptjs'); // Sử dụng bcrypt để hash password

const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');
const TIMES_FILE = path.join(__dirname, 'times.json');

// Sử dụng env vars cho credentials (set trên Vercel dashboard hoặc .env local)
const db = serverlessMysql({
    config: {
        host: process.env.DB_HOST || 'server.dichvucheap.vn',
        user: process.env.DB_USER || 'phkctgnx_ntmdz',
        password: process.env.DB_PASSWORD || '5vYH.c1ijLUq', // Xóa hardcoded này sau khi set env
        database: process.env.DB_NAME || 'phkctgnx_tkb',
        port: process.env.DB_PORT || 3306
    },
    backoff: 'decorrelated',  // Tự reconnect với backoff
    base: 5,  // Số retry
    cap: 200  // Max delay retry
});

// Ping định kỳ để giữ kết nối
async function pingDb() {
    try {
        await db.query('SELECT 1');
    } catch (error) {
        console.error('Ping DB failed:', error);
    }
}

function loadJSON(filePath, defaultValue) {
    try {
        if (fs.existsSync(filePath)) {
            const fileData = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(fileData);
        }
    } catch (error) {
        console.error(`Error reading ${filePath}:`, error);
    }
    return defaultValue;
}

let history = loadJSON(SCHEDULES_FILE, []);
let timesData = loadJSON(TIMES_FILE, { title: '', morning: [], afternoon: [] });
let currentSettings = {};  // Declare biến này để tránh lỗi undefined

(async () => {
    try {
        await pingDb();  // Ping trước load
        currentSettings = await getSettings();  // Handle error ở đây
    } catch (error) {
        console.error('Lỗi khi load settings ban đầu:', error);
        currentSettings = {  // Default nếu fail
            pageTitle: 'Default Title',
            backgroundColor: '#ffffff',
            favicon: '',
            ogTitle: '',
            ogDescription: '',
            canonical: '',
            keywords: ''
        };
    }
})();

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'admin.html')); });

// Thêm route cho favicon để fix 404 (tạo file favicon.ico/png nếu có)
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/favicon.png', (req, res) => res.status(204).end());

const publicNamespace = io.of('/');
publicNamespace.on('connection', async (socket) => {
    console.log('Người Dùng Mới Kết Nối');
    const latestScheduleEntry = history.length > 0 ? history[history.length - 1] : null;
    socket.emit('latestSchedule', latestScheduleEntry);
    try {
        await pingDb();
        const settings = await getSettings();  // Handle error
        socket.emit('updateSettings', { 
            pageTitle: settings.pageTitle, 
            backgroundColor: settings.backgroundColor,
            favicon: settings.favicon || '',
            ogTitle: settings.ogTitle || '',
            ogDescription: settings.ogDescription || '',
            canonical: settings.canonical || '',
            keywords: settings.keywords || ''
        });
    } catch (error) {
        console.error('Lỗi emit settings:', error);
    }
    socket.emit('updateTimes', timesData);
});

const adminNamespace = io.of('/admin');
adminNamespace.use(async (socket, next) => {
    const { username, password } = socket.handshake.auth;

    if (!username || !password) {
        return next(new Error('Thiếu thông tin đăng nhập'));
    }

    try {
        // SỬA Ở ĐÂY: Bỏ dấu ngoặc vuông [] quanh 'rows'
        const rows = await db.query('SELECT * FROM users WHERE username = ?', [username]);

        console.log(`Query result for username '${username}':`, JSON.stringify(rows));

        // Bây giờ 'rows' là một mảng, nên logic này sẽ chạy đúng
        if (!rows || rows.length === 0) {
            return next(new Error('Tài khoản không tồn tại'));
        }

        const user = rows[0];

        const isMatch = await bcrypt.compare(password, user.password);

        if (isMatch) {
            console.log(`User '${username}' authenticated successfully.`);
            return next();
        } else {
            console.log(`Authentication failed for user '${username}': Incorrect password.`);
            return next(new Error('Sai mật khẩu'));
        }

    } catch (err) {
        console.error('Lỗi xác thực:', err);
        return next(new Error('Lỗi hệ thống, không thể xác thực'));
    }
});

adminNamespace.on('connection', (socket) => {
    console.log('Đã Vào Trang Quản Trị');
    socket.emit('authSuccess');
    socket.emit('updateHistory', history);
    socket.emit('updateSettings', { 
        pageTitle: currentSettings.pageTitle, 
        backgroundColor: currentSettings.backgroundColor,
        favicon: currentSettings.favicon || '',
        ogTitle: currentSettings.ogTitle || '',
        ogDescription: currentSettings.ogDescription || '',
        canonical: currentSettings.canonical || '',
        keywords: currentSettings.keywords || ''
    });

    socket.on('saveSchedule', (newSchedule) => {
        const newEntry = { timestamp: new Date().toISOString(), schedule: newSchedule };
        history.push(newEntry);
        try {
            fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(history, null, 2));  // Nhưng trên Vercel, nên migrate sang DB
        } catch (error) {
            console.error('Lỗi lưu file schedules:', error);
        }
        adminNamespace.emit('updateHistory', history);
        publicNamespace.emit('latestSchedule', newEntry);
    });

    socket.on('saveTimes', (newTimesData) => {
        timesData = newTimesData;
        try {
            fs.writeFileSync(TIMES_FILE, JSON.stringify(timesData, null, 2));  // Tương tự, migrate sang DB
        } catch (error) {
            console.error('Lỗi lưu file times:', error);
        }
        io.emit('updateTimes', timesData);
    });
        
    socket.on('saveSettings', async (newSettings) => {
        try {
            await pingDb();
            // Nếu có đổi mật khẩu admin, hash trước khi lưu
            if (newSettings.adminPassword) {
                const hashedPassword = await bcrypt.hash(newSettings.adminPassword, 10);
                await db.query('UPDATE users SET password = ? WHERE username = ?', [hashedPassword, 'admin']);
            }
            delete newSettings.adminPassword; // Không lưu vào settings
            Object.assign(currentSettings, newSettings);
            await saveSettings(currentSettings);
            const publicSettings = { 
                pageTitle: currentSettings.pageTitle, 
                backgroundColor: currentSettings.backgroundColor,
                favicon: currentSettings.favicon,
                ogTitle: currentSettings.ogTitle,
                ogDescription: currentSettings.ogDescription,
                canonical: currentSettings.canonical,
                keywords: currentSettings.keywords
            };
            io.emit('updateSettings', publicSettings);
        } catch (error) {
            console.error('Lỗi save settings:', error);
        }
    });

    socket.on('changeAdminPassword', async ({ username, newPassword }) => {
        if (!username || !newPassword) return;
        try {
            await pingDb();
            const hashedPassword = await bcrypt.hash(newPassword, 10);
            await db.query('UPDATE users SET password = ? WHERE username = ?', [hashedPassword, username]);
            socket.emit('passwordChanged', true);
        } catch (error) {
            console.error('Lỗi change password:', error);
        }
    });
});

async function getSettings() {
    try {
        await pingDb();
        // Sửa ở đây: Bỏ dấu ngoặc vuông []
        const rows = await db.query('SELECT * FROM settings WHERE id=1');
        
        // Logic này giờ sẽ chạy đúng vì 'rows' là một mảng
        return rows[0] || {}; 
    } catch (error) {
        console.error('Lỗi getSettings:', error);
        throw error;
    }
}

async function saveSettings(newSettings) {
    try {
        await pingDb();
        await db.query(
            `UPDATE settings SET 
                pageTitle=?, backgroundColor=?, favicon=?, ogTitle=?, ogDescription=?, canonical=?, keywords=?
             WHERE id=1`,
            [
                newSettings.pageTitle,
                newSettings.backgroundColor,
                newSettings.favicon,
                newSettings.ogTitle,
                newSettings.ogDescription,
                newSettings.canonical,
                newSettings.keywords
            ]
        );
    } catch (error) {
        console.error('Lỗi saveSettings:', error);
        throw error;
    }
}

// Handle close DB khi function end trên Vercel
process.on('SIGTERM', async () => {
    await db.end();
    process.exit(0);
});

const PORT = process.env.PORT || 80;
server.listen(PORT, () => {
    console.log(`🚀 Server đang chạy trên cổng ${PORT}`);
});
