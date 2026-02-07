const express = require('express');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const db = require('./database');

const app = express();
const PORT = 3000;

// ========================================
// 中間件
// ========================================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 請求日誌
app.use((req, res, next) => {
    console.log(`[${new Date().toLocaleString()}] ${req.method} ${req.path}`);
    next();
});

// ========================================
// 靜態文件
// ========================================
app.use(express.static(path.join(__dirname, '..', 'public')));

// ========================================
// 認證 Middleware
// ========================================
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: '未登入' });
    }
    
    const token = authHeader.split(' ')[1];
    
    // 簡單的 token 驗證（實際應用應使用 JWT）
    const user = db.User.findById(token);
    
    if (!user) {
        return res.status(401).json({ error: '登入已過期' });
    }
    
    req.user = user;
    req.token = token;
    next();
};

// ========================================
// API 路由 - 認證
// ========================================

// 登入
app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ success: false, error: '請輸入郵箱和密碼' });
    }
    
    const user = db.User.findByEmail(email);
    
    if (!user || user.password !== password) {
        return res.status(401).json({ success: false, error: '郵箱或密碼錯誤' });
    }
    
    // 生成 token（使用 user ID 作為簡單 token）
    const token = user.id;
    
    res.json({
        success: true,
        token,
        user: {
            id: user.id,
            email: user.email,
            nickname: user.nickname,
            avatar: user.avatar
        }
    });
});

// 註冊
app.post('/api/auth/register', (req, res) => {
    const { nickname, email, password } = req.body;
    
    if (!nickname || !email || !password) {
        return res.status(400).json({ success: false, error: '請填寫完整資料' });
    }
    
    if (password.length < 6) {
        return res.status(400).json({ success: false, error: '密碼至少需要6個字符' });
    }
    
    // 檢查郵箱是否已存在
    const existingUser = db.User.findByEmail(email);
    if (existingUser) {
        return res.status(400).json({ success: false, error: '此郵箱已被註冊' });
    }
    
    const id = uuidv4();
    
    try {
        db.User.create(id, email, nickname, password);
        
        const user = db.User.findById(id);
        const token = id;
        
        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                email: user.email,
                nickname: user.nickname,
                avatar: user.avatar
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: '註冊失敗，請重試' });
    }
});

// 獲取當前用戶資料
app.get('/api/user/me', authMiddleware, (req, res) => {
    res.json({
        user: {
            id: req.user.id,
            email: req.user.email,
            nickname: req.user.nickname,
            avatar: req.user.avatar,
            phone: req.user.phone,
            emergency_contact: req.user.emergency_contact,
            created_at: req.user.created_at
        }
    });
});

// 更新用戶資料
app.put('/api/user/profile', authMiddleware, (req, res) => {
    const { nickname, phone, emergency_contact, avatar } = req.body;
    
    const updates = {};
    if (nickname) updates.nickname = nickname;
    if (phone) updates.phone = phone;
    if (emergency_contact) updates.emergency_contact = emergency_contact;
    if (avatar) updates.avatar = avatar;
    
    db.User.update(req.user.id, updates);
    
    res.json({ success: true, message: '資料已更新' });
});

// ========================================
// API 路由 - 簽到
// ========================================

// 獲取今日簽到狀態
app.get('/api/checkins/today', authMiddleware, (req, res) => {
    const todayCheckin = db.Checkin.getTodayByUser(req.user.id);
    const streak = db.Checkin.getStreak(req.user.id);
    
    res.json({
        checkedIn: !!todayCheckin,
        checkin: todayCheckin ? {
            id: todayCheckin.id,
            status: todayCheckin.status,
            message: todayCheckin.message,
            mood_emoji: todayCheckin.mood_emoji,
            created_at: todayCheckin.created_at
        } : null,
        streakDays: streak
    });
});

// 提交簽到
app.post('/api/checkins', authMiddleware, (req, res) => {
    const { status, message, mood_emoji } = req.body;
    
    if (!status) {
        return res.status(400).json({ success: false, error: '請選擇狀態' });
    }
    
    // 檢查是否已經簽到
    const existingCheckin = db.Checkin.getTodayByUser(req.user.id);
    if (existingCheckin) {
        return res.status(400).json({ success: false, error: '今天已經簽過了' });
    }
    
    const statusEmojis = {
        great: '😊',
        okay: '🙂',
        tired: '😔',
        urgent: '🆘',
        sick: '🤒',
        busy: '😓'
    };
    
    const emoji = mood_emoji || statusEmojis[status] || '😐';
    
    db.Checkin.create(req.user.id, status, message || '', emoji);
    
    // 獲取最新連續天數
    const streak = db.Checkin.getStreak(req.user.id);
    
    // 通知親友
    const contacts = db.Contact.getByUser(req.user.id);
    contacts.forEach(contact => {
        if (contact.status === 'accepted') {
            db.Notification.create(
                contact.contact_email,
                'checkin',
                `${req.user.nickname} 簽到了`,
                message ? `"${message}"` : '今天已報平安'
            );
        }
    });
    
    res.json({
        success: true,
        message: '簽到成功！',
        streakDays: streak
    });
});

// 獲取簽到歷史
app.get('/api/checkins/history', authMiddleware, (req, res) => {
    const limit = parseInt(req.query.limit) || 30;
    const history = db.Checkin.getHistory(req.user.id, limit);
    
    res.json({
        checkins: history.map(c => ({
            id: c.id,
            status: c.status,
            message: c.message,
            mood_emoji: c.mood_emoji,
            created_at: c.created_at
        }))
    });
});

// 獲取本月統計
app.get('/api/checkins/stats/month', authMiddleware, (req, res) => {
    const stmt = db.prepare(`
        SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN status = 'great' THEN 1 ELSE 0 END) as great_count,
            SUM(CASE WHEN status = 'okay' THEN 1 ELSE 0 END) as okay_count,
            SUM(CASE WHEN status = 'tired' THEN 1 ELSE 0 END) as tired_count,
            SUM(CASE WHEN status = 'urgent' THEN 1 ELSE 0 END) as urgent_count
        FROM checkins 
        WHERE user_id = ? 
        AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime')
    `);
    
    const stats = stmt.get(req.user.id);
    
    res.json({
        total: stats.total || 0,
        great: stats.great_count || 0,
        okay: stats.okay_count || 0,
        tired: stats.tired_count || 0,
        urgent: stats.urgent_count || 0
    });
});

// ========================================
// API 路由 - 親友
// ========================================

// 獲取親友列表
app.get('/api/contacts', authMiddleware, (req, res) => {
    const contacts = db.Contact.getByUser(req.user.id);
    
    res.json({
        contacts: contacts.map(c => ({
            id: c.id,
            email: c.contact_email,
            name: c.contact_name || c.nickname || c.contact_email.split('@')[0],
            avatar: c.avatar || '👤',
            status: c.status,
            last_checkin: c.last_checkin
        }))
    });
});

// 添加親友
app.post('/api/contacts', authMiddleware, (req, res) => {
    const { email, name } = req.body;
    
    if (!email) {
        return res.status(400).json({ success: false, error: '請輸入郵箱' });
    }
    
    // 不能添加自己
    if (email === req.user.email) {
        return res.status(400).json({ success: false, error: '不能添加自己' });
    }
    
    // 檢查用戶是否存在
    const contactUser = db.User.findByEmail(email);
    const contactName = name || (contactUser ? contactUser.nickname : null);
    
    try {
        db.Contact.add(req.user.id, email, contactName);
        
        // 如果用戶存在，通知對方
        if (contactUser) {
            db.Notification.create(
                email,
                'friend_request',
                '新的好友請求',
                `${req.user.nickname} 想要添加您為親友`
            );
        }
        
        res.json({
            success: true,
            message: contactUser ? '已發送請求' : '已記錄請求，對方註冊後將自動建立關係'
        });
    } catch (error) {
        res.status(500).json({ success: false, error: '添加失敗' });
    }
});

// 接受/拒絕親友請求
app.put('/api/contacts/:email/accept', authMiddleware, (req, res) => {
    const { email } = req.params;
    const { accept } = req.body;
    
    if (accept) {
        // 對方已經添加了我們，現在建立雙向關係
        db.Contact.add(req.user.id, email);
        db.Contact.accept(req.user.id, email);
        
        res.json({ success: true, message: '已成為親友' });
    } else {
        res.json({ success: true, message: '已拒絕請求' });
    }
});

// ========================================
// API 路由 - 通知
// ========================================

// 獲取通知
app.get('/api/notifications', authMiddleware, (req, res) => {
    const unreadOnly = req.query.unread === 'true';
    const notifications = db.Notification.getByUser(req.user.id, unreadOnly);
    
    res.json({
        notifications: notifications.map(n => ({
            id: n.id,
            type: n.type,
            title: n.title,
            message: n.message,
            read: !!n.read,
            created_at: n.created_at
        }))
    });
});

// 標記通知為已讀
app.put('/api/notifications/:id/read', authMiddleware, (req, res) => {
    db.Notification.markAsRead(req.params.id);
    res.json({ success: true });
});

// ========================================
// API 路由 - 社區動態
// ========================================

// 獲取社區動態
app.get('/api/feed', authMiddleware, (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const feed = db.Checkin.getRecentByCommunity(limit);
    
    res.json({
        feed: feed.map(f => ({
            id: f.id,
            user: {
                id: f.user_id,
                nickname: f.nickname,
                avatar: f.avatar
            },
            status: f.status,
            message: f.message,
            mood_emoji: f.mood_emoji,
            checkin_time: f.created_at
        }))
    });
});

// ========================================
// API 路由 - 緊急求助
// ========================================

// 觸發緊急求助
app.post('/api/emergency/trigger', authMiddleware, (req, res) => {
    const { message, latitude, longitude } = req.body;
    
    // 創建緊急記錄
    db.Emergency.create(req.user.id, message || '需要幫助', latitude, longitude);
    
    // 通知所有親友
    const contacts = db.Contact.getByUser(req.user.id);
    contacts.forEach(contact => {
        if (contact.status === 'accepted') {
            db.Notification.create(
                contact.contact_email,
                'emergency',
                '🆘 緊急求助',
                `${req.user.nickname} 發出了緊急求助訊號`
            );
        }
    });
    
    res.json({
        success: true,
        message: '已向所有親友發送緊急通知'
    });
});

// 獲取最近的緊急求助（管理用）
app.get('/api/emergency/recent', authMiddleware, (req, res) => {
    const emergencies = db.Emergency.getRecent();
    res.json({ emergencies });
});

// ========================================
// API 路由 - 公共 API（無需登入）
// ========================================

// 檢查郵箱是否已註冊
app.get('/api/users/check/:email', (req, res) => {
    const user = db.User.findByEmail(req.params.email);
    res.json({ exists: !!user });
});

// 獲取用戶簡介（用於親友確認）
app.get('/api/users/profile/:email', (req, res) => {
    const user = db.User.findByEmail(req.params.email);
    if (user) {
        res.json({
            nickname: user.nickname,
            avatar: user.avatar
        });
    } else {
        res.status(404).json({ error: '用戶不存在' });
    }
});

// ========================================
// API 路由 - 管理員系統
// ========================================

// 管理員登入
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    
    // 驗證管理員帳號密碼
    if (username !== 'admin_alan' || password !== 'acc!@1757') {
        return res.status(401).json({ 
            success: false, 
            error: '帳號或密碼錯誤' 
        });
    }
    
    // 生成管理員 token
    const token = Buffer.from('admin_alan:acc!@1757').toString('base64');
    
    res.json({
        success: true,
        token: token,
        user: {
            username: 'admin_alan',
            role: 'admin'
        }
    });
});

// 驗證管理員 token
app.get('/api/admin/verify', (req, res) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: '未授權' });
    }
    
    const token = authHeader.split(' ')[1];
    const expectedToken = Buffer.from('admin_alan:acc!@1757').toString('base64');
    
    if (token !== expectedToken) {
        return res.status(401).json({ success: false, error: '無效的 token' });
    }
    
    res.json({ 
        success: true, 
        user: {
            username: 'admin_alan',
            role: 'admin'
        }
    });
});

// 獲取所有簽到記錄（管理員專用）
app.get('/api/admin/checkins', (req, res) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: '未授權' });
    }
    
    const token = authHeader.split(' ')[1];
    const expectedToken = Buffer.from('admin_alan:acc!@1757').toString('base64');
    
    if (token !== expectedToken) {
        return res.status(401).json({ error: '無效的 token' });
    }
    
    // 獲取所有簽到記錄與用戶信息
    const stmt = db.prepare(`
        SELECT 
            c.id,
            c.user_id,
            c.status,
            c.message,
            c.mood_emoji,
            c.created_at,
            u.nickname,
            u.email,
            u.avatar
        FROM checkins c
        LEFT JOIN users u ON c.user_id = u.id
        ORDER BY c.created_at DESC
    `);
    
    const checkins = stmt.all();
    
    res.json({ checkins });
});

// 獲取簽到統計數據
app.get('/api/admin/stats', (req, res) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: '未授權' });
    }
    
    const token = authHeader.split(' ')[1];
    const expectedToken = Buffer.from('admin_alan:acc!@1757').toString('base64');
    
    if (token !== expectedToken) {
        return res.status(401).json({ error: '無效的 token' });
    }
    
    const today = new Date().toISOString().split('T')[0];
    
    // 總簽到數
    const totalStmt = db.prepare('SELECT COUNT(*) as count FROM checkins');
    const totalCheckins = totalStmt.get().count;
    
    // 今日簽到數
    const todayStmt = db.prepare(`
        SELECT COUNT(*) as count FROM checkins 
        WHERE date(created_at) = date(?)
    `);
    const todayCheckins = todayStmt.get(today).count;
    
    // 緊急求助數
    const urgentStmt = db.prepare(`
        SELECT COUNT(*) as count FROM checkins 
        WHERE status = 'urgent' AND date(created_at) = date(?)
    `);
    const urgentCount = urgentStmt.get(today).count;
    
    // 簽到人數
    const usersStmt = db.prepare('SELECT COUNT(DISTINCT user_id) as count FROM checkins');
    const uniqueUsers = usersStmt.get().count;
    
    // 按狀態統計
    const statusStmt = db.prepare(`
        SELECT status, COUNT(*) as count 
        FROM checkins 
        GROUP BY status
    `);
    const statusStats = statusStmt.all();
    
    res.json({
        totalCheckins,
        todayCheckins,
        uniqueUsers,
        urgentCount,
        statusStats: statusStats.reduce((acc, s) => {
            acc[s.status] = s.count;
            return acc;
        }, {})
    });
});

// 獲取所有用戶列表（管理員專用）
app.get('/api/admin/users', (req, res) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: '未授權' });
    }
    
    const token = authHeader.split(' ')[1];
    const expectedToken = Buffer.from('admin_alan:acc!@1757').toString('base64');
    
    if (token !== expectedToken) {
        return res.status(401).json({ error: '無效的 token' });
    }
    
    const users = db.prepare(`
        SELECT 
            id,
            email,
            nickname,
            avatar,
            phone,
            created_at
        FROM users
        ORDER BY created_at DESC
    `).all();
    
    res.json({ users });
});

// ========================================
// SPA 路由支援
// ========================================

// 對於所有非 API 請求，返回 index.html
app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) {
        res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    } else {
        next();
    }
});

// ========================================
// 404 處理
// ========================================
app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
        res.status(404).json({ error: 'API 路由不存在' });
    } else {
        res.status(404).sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    }
});

// ========================================
// 錯誤處理
// ========================================

app.use((err, req, res, next) => {
    console.error('伺服器錯誤:', err);
    res.status(500).json({ error: '伺服器錯誤，請稍後重試' });
});

// ========================================
// 啟動伺服器
// ========================================

app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║                                                      ║
║   🌐 安安簽到系統 - 伺服器已啟動！                   ║
║                                                      ║
║   📍 電腦訪問： http://localhost:3000                ║
║   📍 手機訪問： http://192.168.1.84:3000             ║
║                                                      ║
║   📍 管理後台： http://localhost:3000/admin.html     ║
║                                                      ║
║   📁 資料庫： SQLite (自動建立)                      ║
║   🎯 可用功能：                                      ║
║      ✓ 用戶註冊與登入                                ║
║      ✓ 每日簽到                                      ║
║      ✓ 親友管理                                      ║
║      ✓ 社區動態                                      ║
║      ✓ 緊急求助                                      ║
║      ✓ 通知系統                                      ║
║      ✓ 管理後台（admin_alan / acc!@1757）           ║
║                                                      ║
╚══════════════════════════════════════════════════════╝
    `);
});