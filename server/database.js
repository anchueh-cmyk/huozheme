const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(__dirname, '..', 'data', 'anansign.db');

// 確保 data 目錄存在
const fs = require('fs');
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// 建立所有資料表
db.exec(`
    -- 用戶表
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        nickname TEXT NOT NULL,
        password TEXT NOT NULL,
        avatar TEXT DEFAULT '😊',
        phone TEXT,
        emergency_contact TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 簽到記錄表
    CREATE TABLE IF NOT EXISTS checkins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT,
        mood_emoji TEXT DEFAULT '😐',
        latitude REAL,
        longitude REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- 親友關係表
    CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        contact_email TEXT NOT NULL,
        contact_name TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        UNIQUE(user_id, contact_email)
    );

    -- 通知表
    CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT,
        read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- 緊急求助表
    CREATE TABLE IF NOT EXISTS emergencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        latitude REAL,
        longitude REAL,
        message TEXT,
        resolved INTEGER DEFAULT 0,
        responders TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    );
`);

// 創建索引以提高查詢效能
db.exec(`
    CREATE INDEX IF NOT EXISTS idx_checkins_user_id ON checkins(user_id);
    CREATE INDEX IF NOT EXISTS idx_checkins_created_at ON checkins(created_at);
    CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
`);

module.exports = db;

// 導出便捷函數
module.exports.User = {
    create: (id, email, nickname, password) => {
        const stmt = db.prepare(`
            INSERT INTO users (id, email, nickname, password)
            VALUES (?, ?, ?, ?)
        `);
        return stmt.run(id, email, nickname, password);
    },
    
    findByEmail: (email) => {
        const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
        return stmt.get(email);
    },
    
    findById: (id) => {
        const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
        return stmt.get(id);
    },
    
    update: (id, data) => {
        const fields = [];
        const values = [];
        
        for (const [key, value] of Object.entries(data)) {
            if (key !== 'id' && key !== 'password') {
                fields.push(`${key} = ?`);
                values.push(value);
            }
        }
        values.push(id);
        
        if (fields.length === 0) return;
        
        const stmt = db.prepare(`
            UPDATE users SET ${fields.join(', ')} WHERE id = ?
        `);
        return stmt.run(...values);
    },
    
    getAll: () => {
        const stmt = db.prepare('SELECT id, email, nickname, avatar, created_at FROM users');
        return stmt.all();
    }
};

module.exports.Checkin = {
    create: (userId, status, message, moodEmoji = '😐') => {
        const stmt = db.prepare(`
            INSERT INTO checkins (user_id, status, message, mood_emoji)
            VALUES (?, ?, ?, ?)
        `);
        return stmt.run(userId, status, message, moodEmoji);
    },
    
    getTodayByUser: (userId) => {
        const stmt = db.prepare(`
            SELECT * FROM checkins 
            WHERE user_id = ? 
            AND date(created_at) = date('now', 'localtime')
            ORDER BY created_at DESC LIMIT 1
        `);
        return stmt.get(userId);
    },
    
    getHistory: (userId, limit = 30) => {
        const stmt = db.prepare(`
            SELECT * FROM checkins 
            WHERE user_id = ? 
            ORDER BY created_at DESC 
            LIMIT ?
        `);
        return stmt.all(userId, limit);
    },
    
    getStreak: (userId) => {
        // 計算連續簽到天數
        const stmt = db.prepare(`
            SELECT DISTINCT date(created_at) as checkin_date 
            FROM checkins 
            WHERE user_id = ?
            ORDER BY checkin_date DESC
        `);
        const dates = stmt.all(userId).map(r => r.checkin_date);
        
        if (dates.length === 0) return 0;
        
        let streak = 0;
        const today = new Date().toISOString().split('T')[0];
        let expectedDate = today;
        
        for (let i = 0; i < dates.length; i++) {
            const checkinDate = new Date(dates[i]).toISOString().split('T')[0];
            if (checkinDate === expectedDate || 
                (i === 0 && new Date(checkinDate) > new Date(today))) {
                streak++;
                expectedDate = new Date(new Date(expectedDate) - 86400000).toISOString().split('T')[0];
            } else {
                break;
            }
        }
        
        return streak;
    },
    
    getRecentByCommunity: (limit = 50) => {
        const stmt = db.prepare(`
            SELECT c.*, u.nickname, u.avatar 
            FROM checkins c
            JOIN users u ON c.user_id = u.id
            ORDER BY c.created_at DESC
            LIMIT ?
        `);
        return stmt.all(limit);
    }
};

module.exports.Contact = {
    add: (userId, contactEmail, contactName = null) => {
        const stmt = db.prepare(`
            INSERT OR IGNORE INTO contacts (user_id, contact_email, contact_name, status)
            VALUES (?, ?, ?, 'pending')
        `);
        return stmt.run(userId, contactEmail, contactName);
    },
    
    getByUser: (userId) => {
        const stmt = db.prepare(`
            SELECT c.*, u.nickname, u.avatar, 
                   (SELECT created_at FROM checkins WHERE user_id = c.contact_email ORDER BY created_at DESC LIMIT 1) as last_checkin
            FROM contacts c
            LEFT JOIN users u ON c.contact_email = u.email
            WHERE c.user_id = ?
        `);
        return stmt.all(userId);
    },
    
    accept: (userId, contactEmail) => {
        const stmt = db.prepare(`
            UPDATE contacts SET status = 'accepted' 
            WHERE user_id = ? AND contact_email = ?
        `);
        return stmt.run(userId, contactEmail);
    }
};

module.exports.Notification = {
    create: (userId, type, title, message) => {
        const stmt = db.prepare(`
            INSERT INTO notifications (user_id, type, title, message)
            VALUES (?, ?, ?, ?)
        `);
        return stmt.run(userId, type, title, message);
    },
    
    getByUser: (userId, unreadOnly = false) => {
        let sql = 'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC';
        if (unreadOnly) {
            sql += ' AND read = 0';
        }
        const stmt = db.prepare(sql);
        return stmt.all(userId);
    },
    
    markAsRead: (id) => {
        const stmt = db.prepare('UPDATE notifications SET read = 1 WHERE id = ?');
        return stmt.run(id);
    }
};

module.exports.Emergency = {
    create: (userId, message, lat, lng) => {
        const stmt = db.prepare(`
            INSERT INTO emergencies (user_id, message, latitude, longitude)
            VALUES (?, ?, ?, ?)
        `);
        return stmt.run(userId, message, lat, lng);
    },
    
    getRecent: (hours = 24) => {
        const stmt = db.prepare(`
            SELECT e.*, u.nickname, u.phone, u.emergency_contact
            FROM emergencies e
            JOIN users u ON e.user_id = u.id
            WHERE e.created_at > datetime('now', '-${hours} hours')
            AND e.resolved = 0
            ORDER BY e.created_at DESC
        `);
        return stmt.all();
    }
};

console.log('✅ 資料庫初始化完成！');
console.log(`📁 資料庫位置: ${dbPath}`);