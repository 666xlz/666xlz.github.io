// ==================== 全局状态 ====================
let cardPools = {};  // { poolName: [{id, name, image}] }
let players = [];    // [{id, name, hand: []}]
let tableCards = [];  // [{card, playerName}]
let discardPile = []; // [{id, name, image}]

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
function initHost() {
    loadState();
    renderAll();
    initEventListeners();
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

function saveData() {
    localStorage.setItem('game_data', JSON.stringify({
        cardPools, players, tableCards, discardPile
    }));
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
    const statusDot = document.querySelector('#networkStatus .status-dot');
    const statusText = document.querySelector('#networkStatus .status-text');
    const onlineInfo = document.getElementById('onlineInfo');
    const btnCreate = document.getElementById('btnCreateRoom');
    const btnDisconnect = document.getElementById('btnDisconnect');
    const roomIdDisplay = document.getElementById('roomIdDisplay');
    const playerCount = document.getElementById('playerCount');
    
    if (isOnline) {
        statusDot.className = 'status-dot online';
        statusText.textContent = '在线';
        onlineInfo.style.display = 'flex';
        btnCreate.style.display = 'none';
        btnDisconnect.style.display = 'inline-block';
        roomIdDisplay.textContent = currentRoomId;
        playerCount.textContent = '在线玩家: ' + connections.length;
    } else {
        statusDot.className = 'status-dot offline';
        statusText.textContent = '离线模式';
        onlineInfo.style.display = 'none';
        btnCreate.style.display = 'inline-block';
        btnDisconnect.style.display = 'none';
    }
}

// ==================== 状态管理 ====================
function saveState() {
    saveData();
    broadcastData();
}

function loadState() {
    const saved = localStorage.getItem('game_data');
    if (saved) {
        const state = JSON.parse(saved);
        cardPools = state.cardPools || {};
        players = state.players || [];
        tableCards = state.tableCards || [];
        discardPile = state.discardPile || [];
    }
}

function clearAllData() {
    if (!confirm('确定要清除所有数据吗？此操作不可恢复！')) return;
    localStorage.removeItem('game_data');
    cardPools = {};
    players = [];
    tableCards = [];
    discardPile = [];
    renderAll();
    broadcastData();
    addHostLog(`清除所有数据`, 'system');
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

function deletePool(poolName) {
    showConfirm(`确定删除卡池"${poolName}"吗？`, () => {
        delete cardPools[poolName];
        
        // 如果删除的是当前选中的卡池，切换到其他卡池
        if (activePoolTab === poolName) {
            const remainingPools = Object.keys(cardPools);
            activePoolTab = remainingPools.length > 0 ? remainingPools[0] : null;
        }
        
        saveState();
        renderAll();
        addHostLog(`删除了卡池「${poolName}」`, 'warning');
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
function handleImageUpload(e) {
    const poolName = document.getElementById('targetPoolSelect').value;
    if (!poolName) return alert('请先选择目标卡池');
    
    const files = e.target.files;
    if (files.length === 0) return;
    
    for (let f of files) {
        const reader = new FileReader();
        reader.onload = (ev) => {
            const img = new Image();
            img.onload = () => {
                const cardName = f.name.replace(/\.[^.]+$/, '');
                const card = {
                    id: generateId(),
                    name: cardName,
                    image: ev.target.result
                };
                cardPools[poolName].push(card);
                saveState();
                renderAll();
            };
            img.src = ev.target.result;
        };
        reader.readAsDataURL(f);
    }
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
    renderPlayers();
    renderCardPools();
    renderTable();
    renderDiscardPile();
    updateNetworkUI();
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
