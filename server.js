const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs'); // <--- Thêm module File System
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- 1. ĐỊNH NGHĨA ĐƯỜNG DẪN FILE ---
const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');
const TIMES_FILE = path.join(__dirname, 'times.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

// --- 2. HÀM HELPER ĐỂ ĐỌC FILE JSON ---
function loadJSON(filePath, defaultValue) {
    try {
        if (fs.existsSync(filePath)) {
            const fileData = fs.readFileSync(filePath);
            return JSON.parse(fileData);
        }
    } catch (error) {
        console.error(`Error reading ${filePath}:`, error);
    }
    return defaultValue; // Trả về giá trị mặc định nếu file lỗi hoặc không tồn tại
}

// --- 3. NẠP DỮ LIỆU TỪ FILE KHI SERVER KHỞI ĐỘNG ---
let history = loadJSON(SCHEDULES_FILE, []);
let timesData = loadJSON(TIMES_FILE, { title: '', morning: [], afternoon: [] });
let currentSettings = loadJSON(SETTINGS_FILE, { adminPassword: "admin", pageTitle: "Thời Khóa Biểu", backgroundColor: "#f0f8ff" });

// Serve static files
app.use(express.static(path.join(__dirname)));

// Serve index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve admin.html
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Namespace cho public
const publicNamespace = io.of('/');
publicNamespace.on('connection', (socket) => {
    console.log('A user connected to public');
    // Gửi dữ liệu hiện tại cho client mới kết nối
    socket.emit('updateHistory', history);
    socket.emit('updateSettings', currentSettings);
    socket.emit('updateTimes', timesData);
});

// Namespace cho admin
const adminNamespace = io.of('/admin');
adminNamespace.use((socket, next) => {
    const password = socket.handshake.auth.password;
    if (password === currentSettings.adminPassword) {
        return next();
    }
    return next(new Error('Authentication error'));
});

adminNamespace.on('connection', (socket) => {
    console.log('An admin connected');
    // Gửi dữ liệu hiện tại cho admin
    socket.emit('updateHistory', history);
    socket.emit('updateSettings', currentSettings);
    socket.emit('updateTimes', timesData);

    // Lắng nghe sự kiện lưu TKB
    socket.on('saveSchedule', (newSchedule) => {
        const newEntry = {
            timestamp: new Date().toISOString(),
            schedule: newSchedule
        };
        history.push(newEntry);
        
        // --- 4. LƯU VÀO FILE ---
        fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(history, null, 2));
        
        // Cập nhật cho tất cả client
        io.emit('updateHistory', history);
    });

    // Lắng nghe sự kiện lưu thời gian
    socket.on('saveTimes', (newTimesData) => {
        timesData = newTimesData;
        
        // --- 4. LƯU VÀO FILE ---
        fs.writeFileSync(TIMES_FILE, JSON.stringify(timesData, null, 2));

        // Cập nhật cho tất cả client
        io.emit('updateTimes', timesData);
    });
    
    // Lắng nghe sự kiện lưu cài đặt
    socket.on('saveSettings', (newSettings) => {
        // Cập nhật mật khẩu nếu có
        if (newSettings.adminPassword) {
            currentSettings.adminPassword = newSettings.adminPassword;
        }
        // Cập nhật các cài đặt khác
        currentSettings.pageTitle = newSettings.pageTitle || currentSettings.pageTitle;
        currentSettings.backgroundColor = newSettings.backgroundColor || currentSettings.backgroundColor;
        
        // --- 4. LƯU VÀO FILE ---
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(currentSettings, null, 2));
        
        // Cập nhật cho tất cả client
        io.emit('updateSettings', currentSettings);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});