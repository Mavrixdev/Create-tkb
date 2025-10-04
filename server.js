const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');
const TIMES_FILE = path.join(__dirname, 'times.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
    try {
        const [salt, key] = storedHash.split(':');
        const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
        return key === hash;
    } catch (error) {
        return false;
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

const defaultSettings = {
    adminPassword: process.env.ADMIN_PASSWORD || "admin", // Không mã hóa
    pageTitle: "Thời Khóa Biểu",
    backgroundColor: "#ffffff",
};
let currentSettings = { ...defaultSettings, ...loadJSON(SETTINGS_FILE, {}) };

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'admin.html')); });

const publicNamespace = io.of('/');
publicNamespace.on('connection', (socket) => {
    console.log('Người Dùng Mới Kết Nối');
    const latestScheduleEntry = history.length > 0 ? history[history.length - 1] : null;
    socket.emit('latestSchedule', latestScheduleEntry);
    socket.emit('updateSettings', { 
        pageTitle: currentSettings.pageTitle, 
        backgroundColor: currentSettings.backgroundColor,
    });
    socket.emit('updateTimes', timesData);
});

const adminNamespace = io.of('/admin');
adminNamespace.use((socket, next) => {
    const password = socket.handshake.auth.password;
    if ((password && verifyPassword(password, currentSettings.adminPassword)) || password === currentSettings.adminPassword) {
        return next();
    }
    return next(new Error('Authentication error'));
});

adminNamespace.on('connection', (socket) => {
    console.log('Đã Vào Trang Quản Trị');
    socket.emit('authSuccess');
    socket.emit('updateHistory', history);
    socket.emit('updateSettings', { 
        pageTitle: currentSettings.pageTitle, 
        backgroundColor: currentSettings.backgroundColor,
    });
    socket.emit('updateTimes', timesData);

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
    
    socket.on('saveSettings', (newSettings) => {
        if (newSettings.hasOwnProperty('adminPassword') && newSettings.adminPassword) {
            currentSettings.adminPassword = hashPassword(newSettings.adminPassword);
        }
        if (newSettings.hasOwnProperty('pageTitle')) {
            currentSettings.pageTitle = newSettings.pageTitle;
        }
        if (newSettings.hasOwnProperty('backgroundColor')) {
            currentSettings.backgroundColor = newSettings.backgroundColor;
        }

        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(currentSettings, null, 2));
        
        const publicSettings = { 
            pageTitle: currentSettings.pageTitle, 
            backgroundColor: currentSettings.backgroundColor,
        };
        io.emit('updateSettings', publicSettings);
    });
});

const PORT = process.env.PORT || 80;
server.listen(PORT, () => {
    console.log(`🚀 Server đang chạy trên cổng ${PORT}`);
});
