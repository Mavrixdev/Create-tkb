const express = require('express');
const http = require('http');
const fs = require('fs');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs'); // Để bảo mật hơn, dùng bcrypt hash mật khẩu

const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');
const TIMES_FILE = path.join(__dirname, 'times.json');

const db = mysql.createPool({
    host: 'server.dichvucheap.vn',
    user: 'phkctgnx_ntmdz',
    password: '5vYH.c1ijLUq',
    database: 'phkctgnx_tkb',
    port: 3306 // hoặc 3306 nếu không dùng cổng đặc biệt
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

(async () => {
    currentSettings = await getSettings();
})();

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'admin.html')); });

const publicNamespace = io.of('/');
publicNamespace.on('connection', async (socket) => {
    console.log('Người Dùng Mới Kết Nối');
    const latestScheduleEntry = history.length > 0 ? history[history.length - 1] : null;
    socket.emit('latestSchedule', latestScheduleEntry);
    // Lấy settings mới nhất từ DB
    const settings = await getSettings();
    socket.emit('updateSettings', { 
        pageTitle: settings.pageTitle, 
        backgroundColor: settings.backgroundColor,
        favicon: settings.favicon || '',
        ogTitle: settings.ogTitle || '',
        ogDescription: settings.ogDescription || '',
        canonical: settings.canonical || '',
        keywords: settings.keywords || ''
    });
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
        if (password === user.password) {
            return next();
        } else {
            return next(new Error('Sai mật khẩu'));
        }
    } catch (err) {
        console.error(err);
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
        fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(history, null, 2));
        adminNamespace.emit('updateHistory', history);
        publicNamespace.emit('latestSchedule', newEntry);
    });

    socket.on('saveTimes', (newTimesData) => {
        timesData = newTimesData;
        fs.writeFileSync(TIMES_FILE, JSON.stringify(timesData, null, 2));
        io.emit('updateTimes', timesData);
    });
        
    socket.on('saveSettings', async (newSettings) => {
        // Nếu có đổi mật khẩu admin
        if (newSettings.adminPassword) {
            // Giả sử chỉ có 1 admin, username là 'admin'
            await db.query('UPDATE users SET password = ? WHERE username = ?', [newSettings.adminPassword, 'admin']);
        }
        // Cập nhật các settings khác vào bảng settings như cũ
        // (giả sử bạn đã có hàm saveSettings cho bảng settings)
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
    });

    socket.on('changeAdminPassword', async ({ username, newPassword }) => {
        if (!username || !newPassword) return;
        await db.query('UPDATE users SET password = ? WHERE username = ?', [newPassword, username]);
        socket.emit('passwordChanged', true);
    });
});

async function getSettings() {
    const [rows] = await db.query('SELECT * FROM settings WHERE id=1');
    return rows[0];
}

async function saveSettings(newSettings) {
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
}

const PORT = process.env.PORT || 80;
server.listen(PORT, () => {
    console.log(`🚀 Server đang chạy trên cổng ${PORT}`);
});
