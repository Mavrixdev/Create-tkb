const express = require('express');
const http = require('http');
const fs = require('fs');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');
const TIMES_FILE = path.join(__dirname, 'times.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

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
    if (password && password === currentSettings.adminPassword) {
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
        
    socket.on('saveSettings', (newSettings) => {
        if (newSettings.hasOwnProperty('adminPassword') && newSettings.adminPassword) {
            currentSettings.adminPassword = newSettings.adminPassword;
        }
        if (newSettings.hasOwnProperty('pageTitle')) {
            currentSettings.pageTitle = newSettings.pageTitle;
        }
        if (newSettings.hasOwnProperty('backgroundColor')) {
            currentSettings.backgroundColor = newSettings.backgroundColor;
        }
        // Thêm các trường meta mới
        if (newSettings.hasOwnProperty('favicon')) {
            currentSettings.favicon = newSettings.favicon;
        }
        if (newSettings.hasOwnProperty('ogTitle')) {
            currentSettings.ogTitle = newSettings.ogTitle;
        }
        if (newSettings.hasOwnProperty('ogDescription')) {
            currentSettings.ogDescription = newSettings.ogDescription;
        }
        if (newSettings.hasOwnProperty('canonical')) {
            currentSettings.canonical = newSettings.canonical;
        }
        if (newSettings.hasOwnProperty('keywords')) {
            currentSettings.keywords = newSettings.keywords;
        }
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(currentSettings, null, 2));
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
});

const PORT = process.env.PORT || 80;
server.listen(PORT, () => {
    console.log(`🚀 Server đang chạy trên cổng ${PORT}`);
});
