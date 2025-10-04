const express = require('express');
const http = require('http');
const fs = require('fs');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs'); // Sử dụng bcrypt để hash password

const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');
const TIMES_FILE = path.join(__dirname, 'times.json');

// Tăng timeout cho pool để tránh ETIMEDOUT
const db = mysql.createPool({
    host: 'server.dichvucheap.vn',
    user: 'phkctgnx_ntmdz',
    password: '5vYH.c1ijLUq',
    database: 'phkctgnx_tkb',
    port: 3306,
    connectTimeout: 30000,  // Tăng timeout kết nối (30 giây)
    connectionLimit: 10,   // Giới hạn pool để tránh overload
    waitForConnections: true
});

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

const publicNamespace = io.of('/');
publicNamespace.on('connection', async (socket) => {
    console.log('Người Dùng Mới Kết Nối');
    const latestScheduleEntry = history.length > 0 ? history[history.length - 1] : null;
    socket.emit('latestSchedule', latestScheduleEntry);
    try {
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
    if (!username || !password) return next(new Error('Thiếu thông tin đăng nhập'));
    try {
        const [rows] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
        if (rows.length === 0) return next(new Error('Tài khoản không tồn tại'));
        const user = rows[0];
        // Sử dụng bcrypt để so sánh password (giả sử password trong DB đã hash)
        const isMatch = await bcrypt.compare(password, user.password);
        if (isMatch) {
            return next();
        } else {
            return next(new Error('Sai mật khẩu'));
        }
    } catch (err) {
        console.error('Lỗi auth:', err);
        return next(new Error('Lỗi kết nối database'));
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
        const [rows] = await db.query('SELECT * FROM settings WHERE id=1');
        return rows[0] || {};  // Trả default nếu không có row
    } catch (error) {
        console.error('Lỗi getSettings:', error);
        throw error;  // Để caller handle
    }
}

async function saveSettings(newSettings) {
    try {
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

const PORT = process.env.PORT || 80;
server.listen(PORT, () => {
    console.log(`🚀 Server đang chạy trên cổng ${PORT}`);
});
