// ==================== IndexedDB 存储系统 ====================
const DB_NAME = 'CardGameDB';
const DB_VERSION = 1;
const STORE_CARDS = 'cards';
const STORE_IMAGES = 'images';

// 图片压缩配置
const IMAGE_CONFIG = {
    maxWidth: 800,      // 最大宽度
    maxHeight: 800,     // 最大高度
    quality: 0.7,       // 压缩质量 0-1
    maxSizeKB: 50       // 单张图片最大 KB（用于估算）
};

let db = null;

// ==================== 图片压缩功能 ====================
// 压缩图片到指定尺寸和质量
async function compressImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                // 计算压缩后的尺寸
                let { width, height } = img;
                
                // 按比例缩放
                if (width > IMAGE_CONFIG.maxWidth) {
                    height = Math.round(height * IMAGE_CONFIG.maxWidth / width);
                    width = IMAGE_CONFIG.maxWidth;
                }
                if (height > IMAGE_CONFIG.maxHeight) {
                    width = Math.round(width * IMAGE_CONFIG.maxHeight / height);
                    height = IMAGE_CONFIG.maxHeight;
                }
                
                // 创建 canvas 进行压缩
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                
                // 逐步降低质量直到文件大小合适
                let quality = IMAGE_CONFIG.quality;
                const minQuality = 0.3;
                
                const tryCompress = () => {
                    const dataUrl = canvas.toDataURL('image/jpeg', quality);
                    const sizeKB = Math.round(dataUrl.length * 0.75 / 1024); // base64 → KB 估算
                    
                    if (sizeKB > IMAGE_CONFIG.maxSizeKB && quality > minQuality) {
                        quality -= 0.1;
                        tryCompress();
                    } else {
                        resolve(dataUrl);
                    }
                };
                
                tryCompress();
            };
            img.onerror = () => reject(new Error('图片加载失败'));
            img.src = e.target.result;
        };
        reader.onerror = () => reject(new Error('文件读取失败'));
        reader.readAsDataURL(file);
    });
}

// 初始化 IndexedDB
async function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = () => {
            console.error('IndexedDB 打开失败');
            reject(request.error);
        };
        
        request.onsuccess = () => {
            db = request.result;
            console.log('IndexedDB 已初始化');
            resolve(db);
        };
        
        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            
            // 创建卡牌数据存储（存储卡牌元数据，不含图片）
            if (!database.objectStoreNames.contains(STORE_CARDS)) {
                database.createObjectStore(STORE_CARDS, { keyPath: 'id' });
            }
            
            // 创建图片存储（分离存储大图片）
            if (!database.objectStoreNames.contains(STORE_IMAGES)) {
                database.createObjectStore(STORE_IMAGES, { keyPath: 'id' });
            }
        };
    });
}

// 保存图片到 IndexedDB
async function saveImageToDB(imageId, imageData) {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_IMAGES], 'readwrite');
        const store = transaction.objectStore(STORE_IMAGES);
        const request = store.put({ id: imageId, data: imageData });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// 从 IndexedDB 获取图片
async function getImageFromDB(imageId) {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_IMAGES], 'readonly');
        const store = transaction.objectStore(STORE_IMAGES);
        const request = store.get(imageId);
        request.onsuccess = () => resolve(request.result?.data || null);
        request.onerror = () => reject(request.error);
    });
}

// 删除图片
async function deleteImageFromDB(imageId) {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_IMAGES], 'readwrite');
        const store = transaction.objectStore(STORE_IMAGES);
        const request = store.delete(imageId);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// 保存卡牌数据到 IndexedDB
async function saveCardsToDB(cards) {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_CARDS], 'readwrite');
        const store = transaction.objectStore(STORE_CARDS);
        // 清空现有数据
        store.clear();
        // 添加新数据
        cards.forEach(card => {
            store.put(card);
        });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

// 从 IndexedDB 加载卡牌数据
async function loadCardsFromDB() {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_CARDS], 'readonly');
        const store = transaction.objectStore(STORE_CARDS);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
}

// ==================== 全局状态 ====================
let cardPools = {};  // { poolName: [{id, name, imageId}] }
let players = [];    // [{id, name, hand: []}]
let tableCards = [];  // [{card, playerName}]
let discardPile = []; // [{id, name, imageId}]

let currentPlayerId = null;
let discardSelectMode = false;
let selectedDiscardCards = [];
let selectedPlayerId = null;

// 网络相关
let peer = null;
let connections = [];
let isOnline = false;
let currentRoomId = '';
let playerConnections = {};  // 记录连接选择了哪个角色: { connId: playerId }

let activePoolTab = null;  // 当前选中的卡池标签

// ==================== 初始化 ====================
// 只有通过授权验证后才初始化
async function initHost() {
    await initDB();
    await loadState();
    renderAll();
    initEventListeners();
    initBattlefieldZoom();  // 初始化战场缩放
    updateNetworkUI();
    addHostLog('主持人已就绪', 'system');
    
    // 监听ESC关闭确认弹窗
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeModal();
            closePlayerHandModal();
        }
    });
}

function initEventListeners() {
    document.getElementById('uploadImgs').addEventListener('change', handleImageUpload);
    document.querySelector('#cardModal .modal-close').addEventListener('click', closeModal);
    document.getElementById('cardModal').addEventListener('click', (e) => {
        if (e.target.id === 'cardModal') closeModal();
    });
}

// ==================== 网络功能 ====================
function createRoom() {
    if (peer) {
        alert('房间已创建');
        return;
    }
    
    // 生成房间ID
    currentRoomId = generateRoomId();
    
    peer = new Peer(currentRoomId, {
        debug: 1
    });
    
    peer.on('open', (id) => {
        console.log('房间ID:', id);
        isOnline = true;
        updateNetworkUI();
        showRoomModal(id);
    });
    
    peer.on('connection', (conn) => {
        console.log('玩家连接:', conn.peer);
        setupConnection(conn);
    });
    
    peer.on('error', (err) => {
        console.error('连接错误:', err);
        alert('连接错误: ' + err.message);
        disconnectNetwork();
    });
    
    peer.on('disconnected', () => {
        if (peer && !peer.destroyed) {
            peer.reconnect();
        }
    });
}

function setupConnection(conn) {
    connections.push(conn);
    
    conn.on('open', () => {
        console.log('连接建立');
        // 发送当前数据给新连接的客户端
        conn.send({
            type: 'sync',
            data: { cardPools, players, tableCards, discardPile }
        });
        // 发送战场列表
        broadcastBattleList();
        updateNetworkUI();
    });
    
    conn.on('data', (data) => {
        handlePlayerRequest(conn, data);
    });
    
    conn.on('close', () => {
        connections = connections.filter(c => c !== conn);
        // 清除该连接的角色选择记录
        const connId = conn.connectionId;
        if (playerConnections[connId]) {
            const playerId = playerConnections[connId];
            const player = players.find(p => p.id === playerId);
            const playerName = player ? player.name : '未知';
            delete playerConnections[connId];
            addHostLog(`玩家退出，角色「${playerName}」已释放`, 'system');
            broadcastData();
        }
        updateNetworkUI();
        console.log('玩家断开，剩余:', connections.length);
    });
    
    conn.on('error', (err) => {
        console.error('连接错误:', err);
    });
}

function handlePlayerRequest(conn, data) {
    if (data.type === 'select_player') {
        // 玩家选择角色
        const { playerId } = data;
        const player = players.find(p => p.id === playerId);
        if (!player) return;
        
        // 检查该角色是否已被其他玩家选择
        const connId = conn.connectionId;
        for (const [existingConnId, existingPlayerId] of Object.entries(playerConnections)) {
            if (existingPlayerId === playerId && existingConnId !== connId) {
                conn.send({ type: 'select_result', success: false, message: '该角色已被其他玩家选择' });
                return;
            }
        }
        
        // 记录选择
        playerConnections[connId] = playerId;
        
        // 通知该玩家选择成功
        conn.send({ type: 'select_result', success: true, playerId: playerId, playerName: player.name });
        
        // 同步更新给所有玩家（包含已选中的角色信息）
        broadcastData();
        addHostLog(`玩家选择了角色「${player.name}」`, 'system');
        
    } else if (data.type === 'draw_request') {
        const { playerId, playerName, poolName } = data;
        
        const player = players.find(p => p.id === playerId);
        if (!player) {
            conn.send({ type: 'draw_result', success: false, message: '玩家不存在' });
            return;
        }
        
        if (!cardPools[poolName] || cardPools[poolName].length === 0) {
            conn.send({ type: 'draw_result', success: false, message: '该卡池已空' });
            return;
        }
        
        const index = Math.floor(Math.random() * cardPools[poolName].length);
        const card = cardPools[poolName].splice(index, 1)[0];
        card.id = generateId();
        player.hand.push(card);
        
        saveData();
        renderAll();
        
        conn.send({ type: 'draw_result', success: true, cardName: card.name });
        broadcastData();
        addHostLog(`${playerName} 抽取了「${card.name}」`, 'draw');
        
    } else if (data.type === 'use_card') {
        const { playerId, cardId } = data;
        const player = players.find(p => p.id === playerId);
        if (!player) return;
        
        const index = player.hand.findIndex(c => c.id === cardId);
        if (index === -1) return;
        
        const card = player.hand.splice(index, 1)[0];
        tableCards.push({ card, playerName: player.name });
        
        saveData();
        renderAll();
        broadcastData();
        addHostLog(`${player.name} 使用了「${card.name}」`, 'use');
        
    } else if (data.type === 'discard_card') {
        const { playerId, cardId } = data;
        const player = players.find(p => p.id === playerId);
        if (!player) return;
        
        const index = player.hand.findIndex(c => c.id === cardId);
        if (index === -1) return;
        
        const card = player.hand.splice(index, 1)[0];
        discardPile.push(card);
        
        saveData();
        renderAll();
        broadcastData();
        addHostLog(`${player.name} 弃置了「${card.name}」`, 'discard');
        
    } else if (data.type === 'quit_player') {
        // 玩家退出角色，释放角色
        const connId = conn.connectionId;
        if (playerConnections[connId]) {
            const playerId = playerConnections[connId];
            const player = players.find(p => p.id === playerId);
            delete playerConnections[connId];
            broadcastData();
            addHostLog(`玩家退出，角色「${player ? player.name : playerId}」已释放`, 'system');
        }
        
    } else if (data.type === 'gift_card') {
        // 玩家赠送卡牌
        const { fromPlayerId, fromPlayerName, toPlayerId, toPlayerName, cardId, cardName } = data;
        
        const fromPlayer = players.find(p => p.id === fromPlayerId);
        const toPlayer = players.find(p => p.id === toPlayerId);
        
        if (!fromPlayer || !toPlayer) {
            conn.send({ type: 'gift_result', success: false, message: '玩家不存在' });
            return;
        }
        
        const cardIndex = fromPlayer.hand.findIndex(c => c.id === cardId);
        if (cardIndex === -1) {
            conn.send({ type: 'gift_result', success: false, message: '卡牌不在手牌中' });
            return;
        }
        
        // 执行赠送
        const card = fromPlayer.hand.splice(cardIndex, 1)[0];
        toPlayer.hand.push(card);
        
        saveData();
        renderAll();
        broadcastData();
        
        // 通知赠送者
        conn.send({ type: 'gift_result', success: true, cardName: cardName, targetName: toPlayerName });
        
        // 通知接收者
        const toConnId = Object.entries(playerConnections).find(([connId, pId]) => pId === toPlayerId)?.[0];
        const toConn = connections.find(c => c.connectionId == toConnId);
        if (toConn) {
            toConn.send({ type: 'gift_received', cardName: cardName, fromPlayerName: fromPlayerName });
        }
        
        addHostLog(`${fromPlayerName} 将「${cardName}」赠送给了${toPlayerName}`, 'system');
    } else if (data.type === 'player-join') {
        // 玩家加入战场
        const { name, battleId } = data;
        if (battleRooms[battleId]) {
            const connId = conn.connectionId;
            battleRooms[battleId].players[connId] = { id: connId, name: name || '未知玩家', ready: false };
            saveBattleState();
            broadcastBattleState(battleId);
            broadcastBattleList();
            addBattleLog(`${name} 加入了战场`);
        }
    } else if (data.type === 'battle-join') {
        // 玩家请求战场状态
        const { battleId } = data;
        if (battleRooms[battleId]) {
            conn.send({
                type: 'battle-state',
                battleId,
                data: battleRooms[battleId]
            });
        }
        // 同时发送列表
        broadcastBattleList();
    } else if (data.type === 'player-leave') {
        // 玩家离开战场
        const { battleId } = data;
        if (battleRooms[battleId]) {
            const connId = conn.connectionId;
            const playerName = battleRooms[battleId].players[connId]?.name || '未知';
            delete battleRooms[battleId].players[connId];
            saveBattleState();
            broadcastBattleState(battleId);
            broadcastBattleList();
            addBattleLog(`${playerName} 离开了战场`);
        }
    } else if (data.type === 'battle-place-token') {
        // 玩家放置 Token
        const { token, cardId, name, playerPeerId, battleId } = data;
        if (!battleRooms[battleId]) return;
        const room = battleRooms[battleId];
        const existing = room.tokens.find(t => t.x === token.x && t.y === token.y);
        if (existing) {
            conn.send({ type: 'battle-place-result', success: false, message: '该位置已被占用' });
            return;
        }
        token.id = 'token_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        token.ownerId = playerPeerId || conn.connectionId;
        token.ownerName = name || '未知玩家';
        room.tokens.push(token);
        saveBattleState();
        renderBattleTokens(room.tokens);
        broadcastBattleState(battleId);
        conn.send({ type: 'battle-place-result', success: true });
        addBattleLog(`${name} 放置了「${token.cardName}」到 (${token.x}, ${token.y})`);
    } else if (data.type === 'battle-move-token') {
        // 玩家移动 Token
        const { tokenId, x, y, playerPeerId, battleId } = data;
        if (!battleRooms[battleId]) return;
        const room = battleRooms[battleId];
        const token = room.tokens.find(t => t.id === tokenId);
        const playerId = playerPeerId || conn.connectionId;
        if (!token || (token.ownerId !== playerId && token.ownerId !== 'host')) {
            conn.send({ type: 'battle-move-result', success: false, message: '无权操作' });
            return;
        }
        const existing = room.tokens.find(t => t.x === x && t.y === y && t.id !== tokenId);
        if (existing) {
            conn.send({ type: 'battle-move-result', success: false, message: '该位置已被占用' });
            return;
        }
        token.x = x;
        token.y = y;
        saveBattleState();
        renderBattleTokens(room.tokens);
        broadcastBattleState(battleId);
        conn.send({ type: 'battle-move-result', success: true });
        addBattleLog(`${token.ownerName} 移动了「${token.cardName}」到 (${x}, ${y})`);
    } else if (data.type === 'rotate-token') {
        // 玩家旋转 Token
        const { tokenId, rotation, playerPeerId, battleId } = data;
        if (!battleRooms[battleId]) return;
        const room = battleRooms[battleId];
        const token = room.tokens.find(t => t.id === tokenId);
        const playerId = playerPeerId || conn.connectionId;
        if (!token || (token.ownerId !== playerId && token.ownerId !== 'host')) return;
        token.rotation = rotation;
        saveBattleState();
        renderBattleTokens(room.tokens);
        broadcastBattleState(battleId);
        addBattleLog(`${token.ownerName} 旋转了「${token.cardName}」`);
    } else if (data.type === 'flip-token') {
        // 玩家翻转 Token
        const { tokenId, flipped, playerPeerId, battleId } = data;
        if (!battleRooms[battleId]) return;
        const room = battleRooms[battleId];
        const token = room.tokens.find(t => t.id === tokenId);
        const playerId = playerPeerId || conn.connectionId;
        if (!token || (token.ownerId !== playerId && token.ownerId !== 'host')) return;
        token.flipped = flipped;
        saveBattleState();
        renderBattleTokens(room.tokens);
        broadcastBattleState(battleId);
        addBattleLog(`${token.ownerName} ${flipped ? '翻转' : '取消翻转'}了「${token.cardName}」`);
    } else if (data.type === 'remove-token') {
        // 玩家移除自己的 Token
        const { tokenId, playerPeerId, battleId } = data;
        if (!battleRooms[battleId]) return;
        const room = battleRooms[battleId];
        const token = room.tokens.find(t => t.id === tokenId);
        const playerId = playerPeerId || conn.connectionId;
        if (!token || (token.ownerId !== playerId && token.ownerId !== 'host')) return;
        room.tokens = room.tokens.filter(t => t.id !== tokenId);
        saveBattleState();
        renderBattleTokens(room.tokens);
        broadcastBattleState(battleId);
        conn.send({ type: 'battle-remove-result', success: true });
        addBattleLog(`${token.ownerName} 移除了「${token.cardName}」`);
    }
}

function broadcastLog(message, type = '') {
    if (!isOnline || connections.length === 0) return;
    
    connections.forEach(conn => {
        if (conn.open) {
            conn.send({ type: 'game_log', message: message, logType: type });
        }
    });
}

async function saveData() {
    // 小数据存 localStorage（玩家、桌面、弃牌堆）
    localStorage.setItem('game_data', JSON.stringify({
        cardPools: {}, // 不存卡池具体数据，图片单独存
        players, tableCards, discardPile
    }));
    
    // 分离存储卡池数据和图片
    const poolNames = Object.keys(cardPools);
    const cardsToSave = [];
    const imagesToSave = [];
    
    for (const poolName of poolNames) {
        for (const card of cardPools[poolName]) {
            // 存储卡牌元数据，图片单独存储
            cardsToSave.push({
                id: card.id,
                name: card.name,
                poolName: poolName
            });
            // 存储图片
            if (card.image) {
                imagesToSave.push({
                    id: card.id,
                    data: card.image
                });
            }
        }
    }
    
    await saveCardsToDB(cardsToSave);
    for (const img of imagesToSave) {
        await saveImageToDB(img.id, img.data);
    }
    
    console.log(`已保存 ${cardsToSave.length} 张卡牌到 IndexedDB`);
}

function addHostLog(message, type = '') {
    const logContent = document.getElementById('logContent');
    if (!logContent) return;
    
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const logItem = document.createElement('div');
    logItem.className = 'log-item';
    logItem.innerHTML = `<span class="log-time">${time}</span><span class="log-msg ${type}">${message}</span>`;
    
    logContent.insertBefore(logItem, logContent.firstChild);
    
    while (logContent.children.length > 100) {
        logContent.removeChild(logContent.lastChild);
    }
}

function broadcastData() {
    if (!isOnline || connections.length === 0) return;
    
    // 获取所有已选中的角色ID
    const takenPlayerIds = Object.values(playerConnections);
    
    const data = {
        type: 'sync',
        data: { cardPools, players, tableCards, discardPile, takenPlayerIds }
    };
    
    connections.forEach(conn => {
        if (conn.open) {
            conn.send(data);
        }
    });
}

function disconnectNetwork() {
    if (peer) {
        peer.destroy();
        peer = null;
    }
    connections = [];
    playerConnections = {};
    isOnline = false;
    currentRoomId = '';
    updateNetworkUI();
}

function copyRoomId() {
    if (currentRoomId) {
        navigator.clipboard.writeText(currentRoomId).then(() => {
            alert('房间号已复制到剪贴板！');
        }).catch(() => {
            prompt('请复制房间号:', currentRoomId);
        });
    }
}

function showRoomModal(roomId) {
    const modal = document.createElement('div');
    modal.className = 'network-modal';
    modal.id = 'roomModal';
    modal.innerHTML = `
        <div class="network-modal-content">
            <h3>房间已创建</h3>
            <p>请将房间号发送给其他玩家：</p>
            <div class="room-id">${roomId}</div>
            <p class="small">等待玩家加入...</p>
            <button class="btn btn-secondary" onclick="closeRoomModal()">关闭</button>
        </div>
    `;
    document.body.appendChild(modal);
}

function closeRoomModal() {
    const modal = document.getElementById('roomModal');
    if (modal) modal.remove();
}

function updateNetworkUI() {
    const statusText = document.getElementById('networkStatusText');
    const onlineInfo = document.getElementById('onlineInfo');
    const btnCreate = document.getElementById('btnCreateRoom');
    const btnDisconnect = document.getElementById('btnDisconnect');
    const roomIdDisplay = document.getElementById('roomIdDisplay');
    const playerCount = document.getElementById('playerCount');
    
    if (isOnline) {
        statusText.textContent = '在线';
        statusText.className = 'host-toolbar-status online';
        onlineInfo.style.display = 'inline';
        btnCreate.style.display = 'none';
        btnDisconnect.style.display = 'inline-block';
        roomIdDisplay.textContent = currentRoomId;
        playerCount.textContent = '| 在线: ' + connections.length;
    } else {
        statusText.textContent = '离线';
        statusText.className = 'host-toolbar-status offline';
        onlineInfo.style.display = 'none';
        btnCreate.style.display = 'inline-block';
        btnDisconnect.style.display = 'none';
    }
}

// ==================== 状态管理 ====================
async function saveState() {
    await saveData();
    broadcastData();
}

async function loadState() {
    const saved = localStorage.getItem('game_data');
    if (saved) {
        const state = JSON.parse(saved);
        players = state.players || [];
        tableCards = state.tableCards || [];
        discardPile = state.discardPile || [];
    }
    
    // 从 IndexedDB 加载卡池数据
    try {
        const savedCards = await loadCardsFromDB();
        cardPools = {};
        
        for (const card of savedCards) {
            if (!card.poolName) continue;
            if (!cardPools[card.poolName]) {
                cardPools[card.poolName] = [];
            }
            // 恢复图片数据
            const imageData = await getImageFromDB(card.id);
            cardPools[card.poolName].push({
                id: card.id,
                name: card.name,
                image: imageData
            });
        }
        
        // 加载手牌图片
        for (const player of players) {
            if (player.hand && player.hand.length > 0) {
                for (const card of player.hand) {
                    if (!card.image) {
                        card.image = await getImageFromDB(card.id);
                    }
                }
            }
        }
        
        // 加载桌面卡牌图片
        for (const item of tableCards) {
            if (!item.card.image) {
                item.card.image = await getImageFromDB(item.card.id);
            }
        }
        
        // 加载弃牌堆图片
        for (const card of discardPile) {
            if (!card.image) {
                card.image = await getImageFromDB(card.id);
            }
        }
        
        console.log(`从 IndexedDB 加载了 ${savedCards.length} 张卡牌`);
    } catch (e) {
        console.error('加载卡牌数据失败:', e);
    }
}

async function clearAllData() {
    if (!confirm('确定要清除所有数据吗？此操作不可恢复！')) return;
    localStorage.removeItem('game_data');
    localStorage.removeItem('battle_state');
    cardPools = {};
    players = [];
    tableCards = [];
    discardPile = [];
    battleRooms = {};
    currentActiveBattleRoom = null;
    battleSelectedToken = null;
    
    // 清空 IndexedDB
    try {
        if (db) {
            const tx1 = db.transaction([STORE_CARDS], 'readwrite');
            tx1.objectStore(STORE_CARDS).clear();
            const tx2 = db.transaction([STORE_IMAGES], 'readwrite');
            tx2.objectStore(STORE_IMAGES).clear();
        }
    } catch (e) {
        console.error('清空 IndexedDB 失败:', e);
    }
    
    renderAll();
    broadcastData();
    broadcastBattleList();
    addHostLog(`清除所有数据`, 'system');
    // 重新初始化战场显示
    if (currentMode === 'battle') {
        createBattleRoom();
    }
}

function resetAllHands() {
    if (!confirm('确定要重置所有玩家手牌吗？')) return;
    players.forEach(p => p.hand = []);
    saveState();
    renderAll();
    addHostLog(`重置所有玩家手牌`, 'system');
}

// ==================== 玩家管理 ====================
function addPlayer() {
    const name = document.getElementById('playerNameInput').value.trim();
    if (!name) return alert('请输入玩家名称');
    if (players.find(p => p.name === name)) return alert('玩家已存在');
    players.push({
        id: generateId(),
        name: name,
        hand: []
    });
    document.getElementById('playerNameInput').value = '';
    saveState();
    renderAll();
    addHostLog(`添加了玩家「${name}」`, 'system');
}

function removePlayer(playerId) {
    const player = players.find(p => p.id === playerId);
    if (!player) return;
    
    // 检查是否有玩家正在使用该角色
    const connEntry = Object.entries(playerConnections).find(([connId, pId]) => pId === playerId);
    
    if (connEntry) {
        // 有玩家正在使用该角色，提示是否踢出并删除
        showConfirm(`「${player.name}」当前有玩家在线，踢出后角色将被删除（手牌移至弃牌堆），确定吗？`, () => {
            // 踢出该玩家连接
            const [connId, pId] = connEntry;
            const conn = connections.find(c => c.connectionId === connId);
            if (conn) {
                conn.close();
                connections = connections.filter(c => c !== conn);
            }
            delete playerConnections[connId];
            
            // 将手牌移至弃牌堆
            player.hand.forEach(card => discardPile.push(card));
            
            // 删除角色
            players = players.filter(p => p.id !== playerId);
            saveState();
            renderAll();
            updateNetworkUI();
            broadcastData();
            addHostLog(`删除了角色「${player.name}」并踢出在线玩家，手牌已移至弃牌堆`, 'warning');
        });
    } else {
        // 无玩家在线，直接删除角色
        showConfirm(`确定删除角色「${player.name}」吗？`, () => {
            players = players.filter(p => p.id !== playerId);
            saveState();
            renderAll();
            addHostLog(`删除了角色「${player.name}」`, 'warning');
        });
    }
}

// 踢出玩家（保留角色和手牌）
function kickPlayer(playerId) {
    const player = players.find(p => p.id === playerId);
    if (!player) return;
    
    const connEntry = Object.entries(playerConnections).find(([connId, pId]) => pId === playerId);
    
    if (!connEntry) {
        // 没有玩家在使用该角色
        showConfirm(`「${player.name}」当前没有玩家在线，是否删除该角色？`, () => {
            players = players.filter(p => p.id !== playerId);
            saveState();
            renderAll();
            addHostLog(`删除了空角色「${player.name}」`, 'warning');
        });
        return;
    }
    
    // 有玩家在线，踢出该玩家但保留角色和手牌
    showConfirm(`确定踢出正在使用「${player.name}」的玩家吗？角色和手牌将保留，其他玩家可重新选择。`, () => {
        const [connId, pId] = connEntry;
        const conn = connections.find(c => c.connectionId === connId);
        if (conn) {
            conn.send({ type: 'kicked' });  // 通知玩家被踢
            conn.close();
            connections = connections.filter(c => c !== conn);
        }
        delete playerConnections[connId];
        
        saveState();
        renderAll();
        updateNetworkUI();
        broadcastData();
        addHostLog(`踢出了「${player.name}」的在线玩家，角色和手牌已保留`, 'system');
    });
}

function openPlayerHand(playerId) {
    selectedPlayerId = playerId;
    const player = players.find(p => p.id === playerId);
    if (!player) return;
    
    document.getElementById('modalPlayerName').textContent = player.name + ' 的手牌';
    renderModalPlayerHand(player);
    
    // 更新发牌选择
    const select = document.getElementById('dealPoolSelect');
    select.innerHTML = '<option value="">-- 选择卡池 --</option>';
    Object.keys(cardPools).forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name + ' (' + cardPools[name].length + ')';
        select.appendChild(opt);
    });
    
    document.getElementById('playerHandModal').classList.add('show');
}

function closePlayerHandModal() {
    document.getElementById('playerHandModal').classList.remove('show');
    selectedPlayerId = null;
}

function renderModalPlayerHand(player) {
    const container = document.getElementById('modalPlayerHand');
    if (player.hand.length === 0) {
        container.innerHTML = '<div class="empty-hint">该玩家暂无手牌</div>';
        return;
    }
    container.innerHTML = player.hand.map((card, i) => `
        <div class="card host-card" data-index="${i}">
            <div class="card-front" onclick="enlargeCard('${card.image}', '${card.name}')">
                <img src="${card.image}" alt="${card.name}">
            </div>
            <div class="card-name">${card.name}</div>
            <div class="card-actions">
                <button class="card-action discard" onclick="event.stopPropagation();removeCardFromPlayer(${i})" title="移除">×</button>
            </div>
        </div>
    `).join('');
}

function removeCardFromPlayer(index) {
    const player = players.find(p => p.id === selectedPlayerId);
    if (!player) return;
    const card = player.hand.splice(index, 1)[0];
    discardPile.push(card);
    saveState();
    renderAll();
    renderModalPlayerHand(player);
    addHostLog(`从「${player.name}」移除「${card.name}」`, 'discard');
}

function dealToPlayer() {
    const poolName = document.getElementById('dealPoolSelect').value;
    if (!poolName) return alert('请选择卡池');
    if (!cardPools[poolName] || cardPools[poolName].length === 0) return alert('该卡池已空');
    
    const player = players.find(p => p.id === selectedPlayerId);
    if (!player) return;
    
    const index = Math.floor(Math.random() * cardPools[poolName].length);
    const card = cardPools[poolName].splice(index, 1)[0];
    card.id = generateId();
    player.hand.push(card);
    
    saveState();
    renderAll();
    renderModalPlayerHand(player);
    addHostLog(`向「${player.name}」发牌「${card.name}」`, 'player');
}

function takeBackPlayerCards() {
    const player = players.find(p => p.id === selectedPlayerId);
    if (!player || player.hand.length === 0) return alert('该玩家没有手牌');
    
    const count = player.hand.length;
    player.hand.forEach(card => tableCards.push({ card, playerName: player.name }));
    player.hand = [];
    
    saveState();
    renderAll();
    renderModalPlayerHand(player);
    addHostLog(`回收「${player.name}」${count}张手牌`, 'system');
}

function discardPlayerCards() {
    const player = players.find(p => p.id === selectedPlayerId);
    if (!player || player.hand.length === 0) return alert('该玩家没有手牌');
    
    const count = player.hand.length;
    player.hand.forEach(card => discardPile.push(card));
    player.hand = [];
    
    saveState();
    renderAll();
    renderModalPlayerHand(player);
    addHostLog(`弃置「${player.name}」${count}张手牌`, 'discard');
}

// ==================== 批量发牌 ====================
function toggleAllHands() {
    const poolName = prompt('输入卡池名称（为空则从所有卡池随机）：');
    
    players.forEach(player => {
        if (poolName && cardPools[poolName] && cardPools[poolName].length > 0) {
            const index = Math.floor(Math.random() * cardPools[poolName].length);
            const card = cardPools[poolName].splice(index, 1)[0];
            card.id = generateId();
            player.hand.push(card);
        } else {
            // 从所有卡池随机
            const poolNames = Object.keys(cardPools).filter(k => cardPools[k].length > 0);
            if (poolNames.length > 0) {
                const randomPool = poolNames[Math.floor(Math.random() * poolNames.length)];
                const idx = Math.floor(Math.random() * cardPools[randomPool].length);
                const card = cardPools[randomPool].splice(idx, 1)[0];
                card.id = generateId();
                player.hand.push(card);
            }
        }
    });
    
    saveState();
    renderAll();
    addHostLog(`向所有玩家发牌`, 'info');
}

// ==================== 卡池管理 ====================
function createPool() {
    const name = document.getElementById('poolNameInput').value.trim();
    if (!name) return alert('请输入卡池名称');
    if (cardPools[name]) return alert('卡池已存在');
    cardPools[name] = [];
    document.getElementById('poolNameInput').value = '';
    
    // 切换到新创建的卡池
    activePoolTab = name;
    
    saveState();
    renderAll();
    addHostLog(`创建了卡池「${name}」`, 'system');
}

async function deletePool(poolName) {
    showConfirm(`确定删除卡池"${poolName}"吗？`, async () => {
        // 获取要删除的卡牌 ID
        const cardsToDelete = cardPools[poolName] || [];
        
        // 从 IndexedDB 删除图片
        for (const card of cardsToDelete) {
            await deleteImageFromDB(card.id);
        }
        
        delete cardPools[poolName];
        
        // 如果删除的是当前选中的卡池，切换到其他卡池
        if (activePoolTab === poolName) {
            const remainingPools = Object.keys(cardPools);
            activePoolTab = remainingPools.length > 0 ? remainingPools[0] : null;
        }
        
        // 更新 IndexedDB 中的卡牌元数据
        const cardsToSave = [];
        for (const pName of Object.keys(cardPools)) {
            for (const card of cardPools[pName]) {
                cardsToSave.push({
                    id: card.id,
                    name: card.name,
                    poolName: pName
                });
            }
        }
        await saveCardsToDB(cardsToSave);
        
        saveState();
        renderAll();
        addHostLog(`删除了卡池「${poolName}」及 ${cardsToDelete.length} 张图片`, 'warning');
    });
}

function updatePoolSelect() {
    const select = document.getElementById('targetPoolSelect');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">-- 选择卡池 --</option>';
    Object.keys(cardPools).forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
    });
    if (current && cardPools[current]) select.value = current;
}

// ==================== 图片上传 ====================
async function handleImageUpload(e) {
    const poolName = document.getElementById('targetPoolSelect').value;
    if (!poolName) return alert('请先选择目标卡池');
    
    const files = e.target.files;
    if (files.length === 0) return;
    
    if (!cardPools[poolName]) {
        cardPools[poolName] = [];
    }
    
    let addedCount = 0;
    let totalSize = 0;
    
    for (let f of files) {
        try {
            const originalSizeKB = Math.round(f.size / 1024);
            
            // 压缩图片
            const compressedData = await compressImage(f);
            const compressedSizeKB = Math.round(compressedData.length * 0.75 / 1024);
            
            const cardName = f.name.replace(/\.[^.]+$/, '');
            const cardId = generateId();
            
            const card = {
                id: cardId,
                name: cardName,
                image: compressedData
            };
            cardPools[poolName].push(card);
            
            await saveImageToDB(cardId, compressedData);
            
            addedCount++;
            totalSize += compressedSizeKB;
            
            // 每10张提示一次进度
            if (addedCount % 10 === 0) {
                addHostLog(`已处理 ${addedCount}/${files.length} 张图片...`, 'system');
            }
        } catch (err) {
            console.error('图片处理失败:', err);
        }
    }
    
    // 保存卡牌元数据
    const cardsToSave = [];
    for (const pName of Object.keys(cardPools)) {
        for (const card of cardPools[pName]) {
            cardsToSave.push({
                id: card.id,
                name: card.name,
                poolName: pName
            });
        }
    }
    await saveCardsToDB(cardsToSave);
    
    saveState();
    renderAll();
    addHostLog(`上传了 ${addedCount} 张图片 (共${totalSize}KB) 到「${poolName}」`, 'system');
    e.target.value = '';
}

// ==================== 桌面操作 ====================
function clearTable() {
    const count = tableCards.length;
    if (count === 0) return;
    tableCards.forEach(item => discardPile.push(item.card));
    tableCards = [];
    saveState();
    renderAll();
    addHostLog(`清空桌面，${count}张卡进入弃牌堆`, 'system');
}

function takeBackCard(index) {
    const cardObj = tableCards.splice(index, 1)[0];
    players.push({ id: generateId(), name: cardObj.playerName, hand: [cardObj.card] });
    saveState();
    renderAll();
    addHostLog(`回收桌面卡牌「${cardObj.card.name}」`, 'system');
}

// ==================== 弃牌堆操作 ====================
function toggleDiscardSelect() {
    discardSelectMode = !discardSelectMode;
    selectedDiscardCards = [];
    
    const poolSelect = document.getElementById('recoverPoolSelect');
    poolSelect.style.display = discardSelectMode ? 'inline-block' : 'none';
    poolSelect.innerHTML = '<option value="">选择卡池</option>' + 
        Object.keys(cardPools).map(name => `<option value="${name}">${name}</option>`).join('');
    
    document.getElementById('discardArea').classList.toggle('select-mode', discardSelectMode);
    document.getElementById('recoverBtn').style.display = discardSelectMode ? 'inline-block' : 'none';
    document.getElementById('cancelDiscardBtn').style.display = discardSelectMode ? 'inline-block' : 'none';
    
    renderDiscardPile();
}

function cancelDiscardSelect() {
    discardSelectMode = false;
    selectedDiscardCards = [];
    document.getElementById('discardArea').classList.remove('select-mode');
    document.getElementById('recoverBtn').style.display = 'none';
    document.getElementById('cancelDiscardBtn').style.display = 'none';
    document.getElementById('recoverPoolSelect').style.display = 'none';
    renderDiscardPile();
}

function recoverToPool() {
    if (selectedDiscardCards.length === 0) return;
    const poolSelect = document.getElementById('recoverPoolSelect');
    const poolName = poolSelect.value;
    if (!poolName) {
        addHostLog('请先选择回收目标卡池', 'warning');
        return;
    }
    
    const count = selectedDiscardCards.length;
    if (!cardPools[poolName]) cardPools[poolName] = [];
    
    selectedDiscardCards.forEach(id => {
        const index = discardPile.findIndex(c => c.id === id);
        if (index > -1) {
            const card = discardPile.splice(index, 1)[0];
            card.id = generateId();
            cardPools[poolName].push(card);
        }
    });
    
    cancelDiscardSelect();
    saveState();
    renderAll();
    addHostLog(`回收${count}张卡牌至「${poolName}」`, 'system');
}

// ==================== 模态框 ====================
function enlargeCard(imgSrc, cardName) {
    document.getElementById('modalImg').src = imgSrc;
    document.getElementById('modalName').textContent = cardName || '';
    document.getElementById('cardModal').classList.add('show');
}

function closeModal() {
    document.getElementById('cardModal').classList.remove('show');
}

// ==================== 自定义确认弹窗 ====================
let confirmCallback = null;

function showConfirm(message, onConfirm) {
    document.getElementById('confirmMessage').textContent = message;
    confirmCallback = onConfirm;
    document.getElementById('confirmModal').classList.add('show');
}

function closeConfirm() {
    document.getElementById('confirmModal').classList.remove('show');
    confirmCallback = null;
}

function doConfirm() {
    const callback = confirmCallback;
    closeConfirm();
    if (callback) {
        callback();
    }
}

// ==================== 渲染 ====================
function renderAll() {
    updatePoolSelect();
    renderSidebarPools();
    renderSidebarPlayers();
    renderPlayers();
    renderCardPools();
    renderTable();
    renderDiscardPile();
    updateDiscardCount();
    updateNetworkUI();
    // 战场模式同步
    if (currentMode === 'battle' && currentActiveBattleRoom && battleRooms[currentActiveBattleRoom]) {
        loadBattleCards();
    }
}

function renderPlayers() {
    const container = document.getElementById('playersList');
    if (!container) return;
    
    if (players.length === 0) {
        container.innerHTML = '<div class="empty-hint">暂无角色，请添加</div>';
        return;
    }
    
    // 获取所有被占用的角色ID
    const takenPlayerIds = Object.values(playerConnections);
    
    container.innerHTML = players.map(player => {
        const isTaken = takenPlayerIds.includes(player.id);
        const statusClass = isTaken ? 'taken' : '';
        const statusText = isTaken ? '（在线）' : '（空闲）';
        
        return `
        <div class="player-card ${statusClass}" onclick="openPlayerHand('${player.id}')">
            <div class="player-avatar">${player.name[0] || '?'}</div>
            <div class="player-info">
                <div class="player-name">${player.name} ${statusText}</div>
                <div class="player-hand-count">${player.hand.length} 张手牌</div>
            </div>
            <div class="player-actions">
                ${isTaken ? `<button class="player-btn kick-btn" onclick="event.stopPropagation();kickPlayer('${player.id}')" title="踢出玩家（保留角色）">踢</button>` : ''}
                <button class="player-btn remove-btn" onclick="event.stopPropagation();removePlayer('${player.id}')" title="删除角色">×</button>
            </div>
        </div>
    `}).join('');
}

function renderCardPools() {
    const tabsContainer = document.getElementById('poolTabs');
    const container = document.getElementById('cardPoolsArea');
    if (!container) return;
    container.innerHTML = '';
    
    const poolNames = Object.keys(cardPools);
    
    if (poolNames.length === 0) {
        tabsContainer.innerHTML = '';
        container.innerHTML = '<div class="empty-hint" style="width:100%;text-align:center;">暂无卡池，请先创建</div>';
        return;
    }
    
    // 如果没有选中的标签，默认选中第一个
    if (!activePoolTab || !cardPools[activePoolTab]) {
        activePoolTab = poolNames[0];
    }
    
    // 渲染标签
    tabsContainer.innerHTML = poolNames.map(poolName => `
        <button class="pool-tab ${poolName === activePoolTab ? 'active' : ''}" onclick="switchPoolTab('${poolName}')">
            ${poolName} (${cardPools[poolName].length})
        </button>
    `).join('');
    
    // 渲染当前选中的卡池内容
    const pool = cardPools[activePoolTab];
    const div = document.createElement('div');
    div.className = 'pool-box';
    
    div.innerHTML = `
        <div class="pool-header">
            <span class="pool-title">${activePoolTab} (${pool.length})</span>
            <button class="btn btn-small btn-danger" onclick="deletePool('${activePoolTab}')">删除卡池</button>
        </div>
        <div class="pool-cards ${pool.length === 0 ? 'empty' : ''}">
            ${pool.map(card => `
                <div class="card" onclick="enlargeCard('${card.image}', '${card.name}')">
                    <div class="card-front"><img src="${card.image}" alt="${card.name}"></div>
                    <div class="card-name">${card.name}</div>
                </div>
            `).join('')}
        </div>
    `;
    container.appendChild(div);
}

function switchPoolTab(poolName) {
    activePoolTab = poolName;
    renderCardPools();
}

function renderTable() {
    const container = document.getElementById('tableArea');
    if (!container) return;
    
    if (tableCards.length === 0) {
        container.innerHTML = '<span class="empty-hint">桌面为空</span>';
        return;
    }
    
    container.innerHTML = tableCards.map((item, i) => `
        <div class="table-card">
            <div class="card" onclick="enlargeCard('${item.card.image}', '${item.card.name}')">
                <div class="card-front"><img src="${item.card.image}" alt="${item.card.name}"></div>
                <div class="card-name">${item.card.name}</div>
            </div>
            <div class="player-label">${item.playerName}</div>
        </div>
    `).join('');
}

function renderDiscardPile() {
    const container = document.getElementById('discardArea');
    if (!container) return;
    
    if (discardPile.length === 0) {
        container.className = 'empty';
        container.innerHTML = '<span class="empty-hint">弃牌堆为空</span>';
        return;
    }
    
    container.className = discardSelectMode ? 'select-mode' : '';
    container.innerHTML = discardPile.map(card => `
        <div class="card ${selectedDiscardCards.includes(card.id) ? 'selected' : ''}" 
             onclick="handleDiscardClick('${card.id}', '${card.image}', '${card.name}')">
            <div class="card-front"><img src="${card.image}" alt="${card.name}"></div>
            <div class="card-name">${card.name}</div>
        </div>
    `).join('');
}

function handleDiscardClick(cardId, image, cardName) {
    if (!discardSelectMode) {
        enlargeCard(image, cardName);
        return;
    }
    
    const index = selectedDiscardCards.indexOf(cardId);
    if (index > -1) {
        selectedDiscardCards.splice(index, 1);
    } else {
        selectedDiscardCards.push(cardId);
    }
    renderDiscardPile();
}

// ==================== 侧边栏渲染 ====================
function renderSidebarPools() {
    const container = document.getElementById('sidebarPoolList');
    if (!container) return;
    
    const poolNames = Object.keys(cardPools);
    if (poolNames.length === 0) {
        container.innerHTML = '<div style="font-size:11px;color:#ccc;padding:4px 0;">暂无卡池</div>';
        return;
    }
    
    container.innerHTML = poolNames.map(name => `
        <div class="sidebar-pool-item ${name === activePoolTab ? 'active' : ''}" onclick="switchPoolTab('${name}')">
            <span class="pool-item-name">${name}</span>
            <span class="pool-item-count">${cardPools[name].length}</span>
            <button class="pool-item-delete" onclick="event.stopPropagation();deletePool('${name}')" title="删除">×</button>
        </div>
    `).join('');
}

function renderSidebarPlayers() {
    const container = document.getElementById('sidebarPlayerList');
    if (!container) return;
    
    if (players.length === 0) {
        container.innerHTML = '<div style="font-size:11px;color:#ccc;padding:4px 0;">暂无玩家</div>';
        return;
    }
    
    const takenPlayerIds = Object.values(playerConnections);
    
    container.innerHTML = players.map(player => {
        const isTaken = takenPlayerIds.includes(player.id);
        return `
        <div class="sidebar-player-item ${isTaken ? 'taken' : ''}" onclick="openPlayerHand('${player.id}')">
            <div class="spi-avatar">${player.name[0] || '?'}</div>
            <div class="spi-info">
                <div class="spi-name">${player.name}</div>
                <div class="spi-count">${player.hand.length}张手牌${isTaken ? ' · 在线' : ''}</div>
            </div>
            <div class="spi-actions">
                ${isTaken ? `<button class="spi-btn kick" onclick="event.stopPropagation();kickPlayer('${player.id}')" title="踢出">踢</button>` : ''}
                <button class="spi-btn remove" onclick="event.stopPropagation();removePlayer('${player.id}')" title="删除">×</button>
            </div>
        </div>
    `}).join('');
}

// ==================== 弃牌堆折叠 ====================
let discardCollapsed = false;

function toggleDiscardSection() {
    discardCollapsed = !discardCollapsed;
    const section = document.querySelector('.host-discard-section');
    if (section) {
        section.classList.toggle('collapsed', discardCollapsed);
    }
}

function updateDiscardCount() {
    const el = document.getElementById('discardCount');
    if (el) el.textContent = discardPile.length;
}

// ==================== 工具函数 ====================
function generateId() {
    return 'id_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// ==================== 模式切换 ====================
let currentMode = 'card';

function switchMode(mode) {
    currentMode = mode;
    document.getElementById('tabCardMode').classList.toggle('active', mode === 'card');
    document.getElementById('tabBattleMode').classList.toggle('active', mode === 'battle');
    document.getElementById('cardModeContainer').style.display = mode === 'card' ? '' : 'none';
    document.getElementById('battleModeContainer').classList.toggle('active', mode === 'battle');

    if (mode === 'battle') {
        initBattle();
    }
}

// ==================== 战场系统 ====================
let battleRooms = {};
let currentActiveBattleRoom = null;
let battleRoomCards = [];
let battleSelectedToken = null;
let currentMapBackgroundImage = null;
let hostPlaceMode = false;  // 主持人快速放置模式
let hostSelectedCard = null;  // 主持人选中的卡牌
let battleSelectedCell = null;  // 当前选中的格子坐标 {x, y}

const defaultMapSettings = {
    width: 8,
    height: 6,
    cellSize: 60,
    bgColor: '#2c3e50',
    gridColor: '#34495e',
    name: '默认战场',
    backgroundImage: null
};

function initBattle() {
    loadBattleCards();
    loadBattleState();
    if (Object.keys(battleRooms).length === 0) {
        createBattleRoom();
    } else {
        const firstId = Object.keys(battleRooms)[0];
        selectBattleRoom(firstId);
    }
    renderBattleRoomsList();

    // 地图背景图上传
    document.getElementById('mapBgImageInput').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            currentMapBackgroundImage = ev.target.result;
            applyBattleMapSettings();
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    });
}

function loadBattleCards() {
    battleRoomCards = [];
    for (const poolName in cardPools) {
        cardPools[poolName].forEach(card => {
            battleRoomCards.push({ ...card, poolName });
        });
    }
    // 同时更新快速放置区的卡牌
    renderHostQuickPlaceCards();
}

function createBattleRoom() {
    const id = 'battle_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    const room = {
        id,
        name: '战场 ' + (Object.keys(battleRooms).length + 1),
        mapSettings: { ...defaultMapSettings },
        tokens: [],
        ownerId: 'host',
        ownerName: document.getElementById('currentUserName')?.textContent || '主持人',
        players: {},
        createdAt: Date.now()
    };
    battleRooms[id] = room;
    saveBattleState();
    selectBattleRoom(id);
    renderBattleRoomsList();
    broadcastBattleList();
    addHostLog(`创建了战场「${room.name}」`, 'system');
    addBattleLog(`战场已创建`);
}

function selectBattleRoom(battleId) {
    if (!battleRooms[battleId]) return;
    currentActiveBattleRoom = battleId;
    const room = battleRooms[battleId];

    // 更新地图设置面板
    document.getElementById('mapName').value = room.mapSettings.name;
    document.getElementById('mapWidth').value = room.mapSettings.width;
    document.getElementById('mapHeight').value = room.mapSettings.height;
    document.getElementById('mapCellSize').value = room.mapSettings.cellSize || 60;
    document.getElementById('mapBgColor').value = room.mapSettings.bgColor;
    document.getElementById('mapGridColor').value = room.mapSettings.gridColor;
    currentMapBackgroundImage = room.mapSettings.backgroundImage;

    // 取消选中
    battleSelectedToken = null;
    document.getElementById('tokenActionsPanel').classList.remove('active');

    loadBattleCards();
    generateBattlefield(room.mapSettings);
    renderBattleTokens(room.tokens);
    renderBattleRoomsList();
}

function deleteBattleRoom(battleId) {
    if (!battleRooms[battleId]) return;
    showConfirm(`确定删除战场「${battleRooms[battleId].name}」吗？`, () => {
        delete battleRooms[battleId];
        saveBattleState();
        broadcastBattleList();

        const remaining = Object.keys(battleRooms);
        if (remaining.length > 0) {
            selectBattleRoom(remaining[0]);
        } else {
            currentActiveBattleRoom = null;
            document.getElementById('battlefieldGrid').innerHTML = '';
            document.getElementById('tokenActionsPanel').classList.remove('active');
        }
        renderBattleRoomsList();
        addHostLog(`删除了战场`, 'system');
    });
}

function renderBattleRoomsList() {
    const container = document.getElementById('battleRoomsList');
    if (!container) return;
    const ids = Object.keys(battleRooms);
    if (ids.length === 0) {
        container.innerHTML = '<div style="color:#ccc;font-size:12px;padding:4px;">暂无战场</div>';
        return;
    }
    container.innerHTML = ids.map(id => {
        const room = battleRooms[id];
        const isActive = id === currentActiveBattleRoom;
        return `
            <button class="battle-room-tab ${isActive ? 'active' : ''}" onclick="selectBattleRoom('${id}')">
                ${room.name}
                <span class="room-delete" onclick="event.stopPropagation();deleteBattleRoom('${id}')" title="删除">×</span>
            </button>
        `;
    }).join('');
}

function toggleMapSettings() {
    document.getElementById('mapSettingsPanel').classList.toggle('active');
}

function applyBattleMapSettings() {
    if (!currentActiveBattleRoom || !battleRooms[currentActiveBattleRoom]) return;
    const room = battleRooms[currentActiveBattleRoom];
    room.mapSettings = {
        width: parseInt(document.getElementById('mapWidth').value) || 8,
        height: parseInt(document.getElementById('mapHeight').value) || 6,
        cellSize: parseInt(document.getElementById('mapCellSize').value) || 60,
        bgColor: document.getElementById('mapBgColor').value,
        gridColor: document.getElementById('mapGridColor').value,
        name: document.getElementById('mapName').value || '默认战场',
        backgroundImage: currentMapBackgroundImage
    };
    generateBattlefield(room.mapSettings);
    renderBattleTokens(room.tokens);
    saveBattleState();
    broadcastBattleState(currentActiveBattleRoom);
    addBattleLog(`地图设置已更新 (${room.mapSettings.width}x${room.mapSettings.height} @ ${room.mapSettings.cellSize}px)`);
}

function removeMapBgImage() {
    currentMapBackgroundImage = null;
    // 清理文件输入框
    const fileInput = document.getElementById('mapBgImageInput');
    if (fileInput) fileInput.value = '';
    
    if (currentActiveBattleRoom && battleRooms[currentActiveBattleRoom]) {
        battleRooms[currentActiveBattleRoom].mapSettings.backgroundImage = null;
        applyBattleMapSettings();
        addBattleLog('已移除背景图');
    }
}

// ==================== 战场缩放功能 ====================
let battlefieldZoom = 1;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3;
let isPanning = false;
let panStartX = 0, panStartY = 0;
let panStartScrollLeft = 0, panStartScrollTop = 0;

function initBattlefieldZoom() {
    const scrollContainer = document.getElementById('battlefieldScroll');
    const container = document.getElementById('battlefieldZoomContainer');
    if (!scrollContainer || !container) return;

    // 滚轮缩放（以选中的格子为原点）
    scrollContainer.addEventListener('wheel', (e) => {
        e.preventDefault();
        
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, battlefieldZoom * delta));
        
        if (newZoom === battlefieldZoom) return;
        battlefieldZoom = newZoom;
        applyBattlefieldZoom();
    }, { passive: false });

    // 左键拖拽滚动（仅在空白区域有效）
    scrollContainer.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.battle-token')) return;
        
        isPanning = true;
        panStartX = e.clientX;
        panStartY = e.clientY;
        panStartScrollLeft = scrollContainer.scrollLeft;
        panStartScrollTop = scrollContainer.scrollTop;
        scrollContainer.style.cursor = 'grabbing';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isPanning) return;
        const dx = panStartX - e.clientX;
        const dy = panStartY - e.clientY;
        scrollContainer.scrollLeft = panStartScrollLeft + dx;
        scrollContainer.scrollTop = panStartScrollTop + dy;
    });

    document.addEventListener('mouseup', () => {
        if (isPanning) {
            isPanning = false;
            scrollContainer.style.cursor = '';
        }
    });

    scrollContainer.addEventListener('selectstart', (e) => {
        if (isPanning) e.preventDefault();
    });
}

function applyBattlefieldZoom() {
    const container = document.getElementById('battlefieldZoomContainer');
    const display = document.getElementById('zoomLevelDisplay');
    if (!container) return;
    
    // 计算transform-origin（以选中的格子为中心）
    let originX = '0px';
    let originY = '0px';
    
    if (battleSelectedCell && currentActiveBattleRoom && battleRooms[currentActiveBattleRoom]) {
        const cellSize = battleRooms[currentActiveBattleRoom].mapSettings.cellSize || 60;
        originX = (battleSelectedCell.x * cellSize) + 'px';
        originY = (battleSelectedCell.y * cellSize) + 'px';
    }
    
    container.style.transformOrigin = `${originX} ${originY}`;
    container.style.transform = `scale(${battlefieldZoom})`;
    
    if (display) {
        display.textContent = Math.round(battlefieldZoom * 100) + '%';
    }
}

function zoomBattlefield(delta) {
    battlefieldZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, battlefieldZoom + delta));
    applyBattlefieldZoom();
}

function resetBattlefieldZoom() {
    battlefieldZoom = 1;
    applyBattlefieldZoom();
}

function generateBattlefield(settings) {
    const grid = document.getElementById('battlefieldGrid');
    if (!grid) return;
    const cellSize = settings.cellSize || 60;
    grid.style.gridTemplateColumns = `repeat(${settings.width}, ${cellSize}px)`;
    grid.style.background = settings.gridColor;

    // 使用DocumentFragment优化DOM操作
    const fragment = document.createDocumentFragment();
    for (let y = 0; y < settings.height; y++) {
        for (let x = 0; x < settings.width; x++) {
            const cell = document.createElement('div');
            cell.className = 'battlefield-cell' + (settings.backgroundImage ? ' bg-image' : '');
            cell.dataset.x = x;
            cell.dataset.y = y;
            let cellStyle = `background:${settings.bgColor};width:${cellSize}px;height:${cellSize}px;`;
            if (settings.backgroundImage) {
                cellStyle = `background-color:${settings.bgColor};background-image:url(${settings.backgroundImage});background-size:${settings.width * cellSize}px ${settings.height * cellSize}px;background-position:-${x * cellSize}px -${y * cellSize}px;width:${cellSize}px;height:${cellSize}px;`;
            }
            cell.style.cssText = cellStyle;
            cell.onclick = () => onBattleCellClick(x, y);
            cell.ondragover = (e) => { e.preventDefault(); cell.classList.add('drag-over'); };
            cell.ondragleave = () => cell.classList.remove('drag-over');
            cell.ondrop = (e) => onBattleCellDrop(e, x, y);
            fragment.appendChild(cell);
        }
    }
    grid.innerHTML = '';
    grid.appendChild(fragment);
}

// ==================== 主持人快速放置模式 ====================
function toggleHostPlaceMode() {
    hostPlaceMode = !hostPlaceMode;
    const panel = document.getElementById('hostQuickPlace');
    if (hostPlaceMode) {
        panel.style.display = 'flex';
        hostSelectedCard = null;
        // 取消其他模式的选中
        deselectBattleToken();
        renderHostQuickPlaceCards();
    } else {
        panel.style.display = 'none';
        hostSelectedCard = null;
        renderHostQuickPlaceCards();
    }
}

function renderHostQuickPlaceCards() {
    const container = document.getElementById('hostQuickCardsGrid');
    if (!container) return;

    // 收集所有可用的卡牌（从卡池）
    const allCards = [];
    for (const poolName in cardPools) {
        cardPools[poolName].forEach(card => {
            allCards.push({ ...card, poolName });
        });
    }

    if (allCards.length === 0) {
        container.innerHTML = '<div style="color:#ccc;font-size:12px;padding:10px;">暂无卡牌，请先在卡池中上传</div>';
        return;
    }

    container.innerHTML = allCards.map(card => `
        <div class="host-quick-card ${hostSelectedCard && hostSelectedCard.id === card.id ? 'selected' : ''}"
             onclick="hostSelectCardForPlace('${card.id}')"
             title="${card.name}">
            <img src="${card.image}" alt="${card.name}">
        </div>
    `).join('');
}

function hostSelectCardForPlace(cardId) {
    // 收集所有卡牌（因为 battleRoomCards 可能不包含所有卡）
    const allCards = [];
    for (const poolName in cardPools) {
        cardPools[poolName].forEach(card => {
            allCards.push({ ...card, poolName });
        });
    }

    const card = allCards.find(c => c.id === cardId);
    if (!card) {
        alert('未找到该卡牌');
        return;
    }

    if (hostSelectedCard && hostSelectedCard.id === cardId) {
        // 取消选择
        hostSelectedCard = null;
    } else {
        hostSelectedCard = card;
    }

    renderHostQuickPlaceCards();
}

function cancelHostPlaceMode() {
    hostPlaceMode = false;
    hostSelectedCard = null;
    document.getElementById('hostQuickPlace').style.display = 'none';
    renderHostQuickPlaceCards();
}

function onBattleCellClick(x, y) {
    if (!currentActiveBattleRoom || !battleRooms[currentActiveBattleRoom]) return;
    const room = battleRooms[currentActiveBattleRoom];

    // 记录选中的格子（用于缩放基点）
    battleSelectedCell = { x, y };
    highlightSelectedCell();

    // 主持人快速放置模式
    if (hostPlaceMode && hostSelectedCard) {
        // 检查位置是否已被占用
        const existing = room.tokens.find(t => t.x === x && t.y === y);
        if (existing) {
            alert('该位置已被占用');
            return;
        }

        const token = {
            id: 'token_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
            cardId: hostSelectedCard.id,
            cardName: hostSelectedCard.name,
            cardImage: hostSelectedCard.image,
            x: x,
            y: y,
            ownerId: 'host',
            ownerName: document.getElementById('currentUserName')?.textContent || '主持人',
            rotation: 0,
            flipped: false
        };

        room.tokens.push(token);
        saveBattleState();
        renderBattleTokens(room.tokens);
        // 不取消选择，允许连续放置
        broadcastBattleState(currentActiveBattleRoom);
        addBattleLog(`主持人放置了「${token.cardName}」到 (${x}, ${y})`);
        return;
    }

    // 检查是否点击了 Token
    const clickedToken = room.tokens.find(t => t.x === x && t.y === y);
    if (clickedToken) {
        selectBattleToken(clickedToken);
    } else {
        deselectBattleToken();
    }
}

function highlightSelectedCell() {
    // 移除之前的选中高亮
    document.querySelectorAll('.cell-selected').forEach(el => el.classList.remove('cell-selected'));
    
    // 高亮当前选中的格子
    if (battleSelectedCell) {
        const cell = document.querySelector(`.battlefield-cell[data-x="${battleSelectedCell.x}"][data-y="${battleSelectedCell.y}"]`);
        if (cell) {
            cell.classList.add('cell-selected');
        }
    }
}

// ==================== Token 操作 ====================
function selectBattleToken(token) {
    battleSelectedToken = token;

    // 显示右侧Token信息面板
    const panel = document.getElementById('tokenActionsPanel');
    panel.classList.add('active');
    document.getElementById('tokenPreviewImg').src = token.cardImage;
    document.getElementById('tokenPreviewName').textContent = token.cardName;
    document.getElementById('tokenPreviewOwner').textContent = `${token.ownerName} | (${token.x}, ${token.y})`;

    // 高亮
    renderBattleTokens(battleRooms[currentActiveBattleRoom]?.tokens || []);
}

function deselectBattleToken() {
    battleSelectedToken = null;
    document.getElementById('tokenActionsPanel').classList.remove('active');
    if (currentActiveBattleRoom && battleRooms[currentActiveBattleRoom]) {
        renderBattleTokens(battleRooms[currentActiveBattleRoom].tokens);
    }
}

function rotateBattleToken() {
    if (!battleSelectedToken || !currentActiveBattleRoom) return;
    const room = battleRooms[currentActiveBattleRoom];
    const token = room.tokens.find(t => t.id === battleSelectedToken.id);
    if (!token) return;

    token.rotation = (token.rotation + 90) % 360;
    battleSelectedToken = token;
    saveBattleState();
    renderBattleTokens(room.tokens);
    selectBattleToken(token);
    broadcastBattleState(currentActiveBattleRoom);
    addBattleLog(`旋转了「${token.cardName}」到 ${token.rotation}°`);
}

function flipBattleToken() {
    if (!battleSelectedToken || !currentActiveBattleRoom) return;
    const room = battleRooms[currentActiveBattleRoom];
    const token = room.tokens.find(t => t.id === battleSelectedToken.id);
    if (!token) return;

    token.flipped = !token.flipped;
    battleSelectedToken = token;
    saveBattleState();
    renderBattleTokens(room.tokens);
    selectBattleToken(token);
    broadcastBattleState(currentActiveBattleRoom);
    addBattleLog(`${token.flipped ? '翻转' : '取消翻转'}了「${token.cardName}」`);
}

function removeBattleToken() {
    if (!battleSelectedToken || !currentActiveBattleRoom) return;
    const room = battleRooms[currentActiveBattleRoom];
    const token = room.tokens.find(t => t.id === battleSelectedToken.id);
    if (!token) return;

    showConfirm(`确定删除 Token「${token.cardName}」吗？`, () => {
        room.tokens = room.tokens.filter(t => t.id !== token.id);
        battleSelectedToken = null;
        document.getElementById('tokenActionsPanel').classList.remove('active');
        saveBattleState();
        renderBattleTokens(room.tokens);
        broadcastBattleState(currentActiveBattleRoom);
        addBattleLog(`移除了「${token.cardName}」`);
    });
}

// ==================== 拖拽移动 ====================
function onBattleCellDrop(event, x, y) {
    event.preventDefault();
    event.currentTarget.classList.remove('drag-over');

    if (!currentActiveBattleRoom || !battleRooms[currentActiveBattleRoom]) return;
    const room = battleRooms[currentActiveBattleRoom];

    const tokenId = event.dataTransfer.getData('text/plain');
    if (!tokenId) return;

    const token = room.tokens.find(t => t.id === tokenId);
    if (!token) return;

    // 检查目标位置
    const existing = room.tokens.find(t => t.x === x && t.y === y && t.id !== tokenId);
    if (existing) {
        alert('该位置已被占用');
        return;
    }

    token.x = x;
    token.y = y;
    saveBattleState();
    renderBattleTokens(room.tokens);
    broadcastBattleState(currentActiveBattleRoom);
    addBattleLog(`移动了「${token.cardName}」到 (${x}, ${y})`);
}

function renderBattleTokens(tokens) {
    if (!currentActiveBattleRoom || !battleRooms[currentActiveBattleRoom]) return;
    const grid = document.getElementById('battlefieldGrid');
    if (!grid) return;

    // 清除所有已有 Token
    grid.querySelectorAll('.battle-token').forEach(el => el.remove());

    tokens.forEach(token => {
        const cell = grid.querySelector(`.battlefield-cell[data-x="${token.x}"][data-y="${token.y}"]`);
        if (!cell) return;

        const el = document.createElement('div');
        el.className = 'battle-token' + (battleSelectedToken && battleSelectedToken.id === token.id ? ' selected' : '') + (token.flipped ? ' flipped' : '');
        el.draggable = true;
        el.dataset.tokenId = token.id;

        let imgHtml = '';
        if (token.flipped) {
            imgHtml = `<img src="${token.cardImage}" alt="${token.cardName}" style="filter:blur(5px);">`;
        } else {
            imgHtml = `<img src="${token.cardImage}" alt="${token.cardName}" style="transform:rotate(${token.rotation}deg);">`;
        }

        el.innerHTML = `
            <div class="battle-token-owner">${token.ownerName}</div>
            ${imgHtml}
            <div class="battle-token-name">${token.cardName}</div>
            ${token.rotation !== 0 && !token.flipped ? `<div class="rotation-badge">↻</div>` : ''}
        `;

        el.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', token.id);
            e.dataTransfer.effectAllowed = 'move';
        });

        el.addEventListener('dragend', (e) => {
            // 清除所有拖拽状态
            document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        });

        cell.classList.add('has-token');
        cell.appendChild(el);
    });
    
    // 保留选中格子高亮
    highlightSelectedCell();
}

// ==================== 战场通信 ====================
function broadcastBattleList() {
    if (!isOnline || connections.length === 0) return;
    const list = Object.keys(battleRooms).map(id => ({
        id,
        name: battleRooms[id].name,
        playerCount: Object.keys(battleRooms[id].players).length
    }));
    connections.forEach(conn => {
        if (conn.open) {
            conn.send({ type: 'battle-list', battleRooms: list });
        }
    });
}

function broadcastBattleState(battleId) {
    if (!isOnline || connections.length === 0) return;
    if (!battleRooms[battleId]) return;
    connections.forEach(conn => {
        if (conn.open) {
            conn.send({
                type: 'battle-state',
                battleId,
                data: battleRooms[battleId]
            });
        }
    });
}

// ==================== 战场日志 ====================
function addBattleLog(message) {
    const container = document.getElementById('battleLogContainer');
    if (!container) return;
    container.style.display = 'block';

    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const item = document.createElement('div');
    item.className = 'battle-log-item';
    item.innerHTML = `<span class="battle-log-time">${time}</span>${message}`;
    container.insertBefore(item, container.firstChild);

    while (container.children.length > 50) {
        container.removeChild(container.lastChild);
    }
}

// ==================== 战场状态持久化 ====================
function saveBattleState() {
    localStorage.setItem('battle_state', JSON.stringify({ battleRooms }));
}

function loadBattleState() {
    const saved = localStorage.getItem('battle_state');
    if (saved) {
        try {
            const state = JSON.parse(saved);
            battleRooms = state.battleRooms || {};
        } catch (e) {
            battleRooms = {};
        }
    }
}
