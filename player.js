// ==================== 全局状态 ====================
let cardPools = {};
let players = [];
let tableCards = [];
let discardPile = [];

let currentPlayerId = null;
let currentPlayerName = '';
let lastSelectedPool = localStorage.getItem('last_pool') || '';
let takenPlayerIds = [];  // 已被其他玩家选中的角色ID

// 赠送相关
let selectedGiftCard = null;  // 选中的要赠送的卡牌
let selectedGiftTarget = null;  // 选中的目标玩家

// 网络相关
let peer = null;
let isConnected = false;
let hostId = '';

// ==================== 初始化 ====================
window.addEventListener('load', () => {
    loadState();
    initEventListeners();
    
    // 检查是否有记住的玩家
    const savedPlayerId = localStorage.getItem('current_player_id');
    if (savedPlayerId) {
        const player = players.find(p => p.id === savedPlayerId);
        if (player) {
            currentPlayerId = player.id;
            currentPlayerName = player.name;
            showPlayerInterface();
            return;
        }
    }
    
    renderPlayerSelect();
});

function initEventListeners() {
    document.querySelector('#cardModal .modal-close').addEventListener('click', closeModal);
    document.getElementById('cardModal').addEventListener('click', (e) => {
        if (e.target.id === 'cardModal') closeModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
    });
    document.getElementById('drawPoolSelect')?.addEventListener('change', updatePoolHint);
}

// ==================== 网络功能 ====================
function joinRoom() {
    const roomId = document.getElementById('roomIdInput').value.trim().toUpperCase();
    if (!roomId) {
        alert('请输入房间号');
        return;
    }
    
    if (peer) {
        alert('已在房间中');
        return;
    }
    
    updateNetworkStatus('connecting');
    
    peer = new Peer({
        debug: 1
    });
    
    peer.on('open', (id) => {
        console.log('我的ID:', id);
        // 连接到主持人
        const conn = peer.connect(roomId, { reliable: true });
        
        conn.on('open', () => {
            console.log('连接到主持人');
            isConnected = true;
            hostId = roomId;
            updateNetworkStatus('online');
            document.getElementById('joinRoomForm').style.display = 'none';
            document.getElementById('onlineInfo').style.display = 'flex';
            document.getElementById('connectionTip').style.display = 'none';
        });
        
        conn.on('data', (data) => {
            handleReceivedData(data);
        });
        
        conn.on('close', () => {
            console.log('与主持人断开连接');
            isConnected = false;
            updateNetworkStatus('offline');
            alert('与主持人断开连接');
        });
        
        conn.on('error', (err) => {
            console.error('连接错误:', err);
            alert('连接失败，请检查房间号是否正确');
            updateNetworkStatus('offline');
        });
    });
    
    peer.on('error', (err) => {
        console.error('PeerJS错误:', err);
        if (err.type === 'peer-unavailable') {
            alert('房间不存在或主持人已断开');
        }
        updateNetworkStatus('offline');
    });
}

function handleReceivedData(data) {
    if (data.type === 'sync') {
        cardPools = data.data.cardPools || {};
        players = data.data.players || [];
        tableCards = data.data.tableCards || [];
        discardPile = data.data.discardPile || [];
        takenPlayerIds = data.data.takenPlayerIds || [];
        
        // 检查是否正在游戏界面中
        const isInGame = document.getElementById('playerInterface')?.style.display === 'block';
        
        // 更新当前玩家
        if (currentPlayerId) {
            const player = players.find(p => p.id === currentPlayerId);
            if (player) {
                currentPlayerName = player.name;
                document.getElementById('currentPlayerName').textContent = currentPlayerName;
            } else if (isInGame) {
                // 当前选中的玩家已被删除且在游戏中，退出游戏界面
                currentPlayerId = null;
                currentPlayerName = '';
            }
        }
        
        // 只有在选择角色界面时才更新玩家选择按钮
        if (!isInGame) {
            renderPlayerSelect();
        }
        
        renderAll();
    } else if (data.type === 'select_result') {
        if (data.success) {
            currentPlayerId = data.playerId;
            currentPlayerName = data.playerName;
            localStorage.setItem('current_player_id', currentPlayerId);
            showPlayerInterface();
        } else {
            addGameLog(`选择失败：${data.message}`, 'system');
            renderPlayerSelect();  // 刷新按钮状态
        }
    } else if (data.type === 'draw_result') {
        if (data.success) {
            addGameLog(`抽取了「${data.cardName}」`, 'draw');
        }
    } else if (data.type === 'game_log') {
        // 只显示与当前玩家相关的日志
        if (data.message.includes(currentPlayerName)) {
            addGameLog(data.message, data.logType);
        }
    } else if (data.type === 'kicked') {
        // 被主持人踢出
        addGameLog('你被主持人移出了角色', 'warning');
        alert('你被主持人移出了当前角色，可以重新选择其他角色');
        // 返回角色选择界面，保留当前角色ID以便显示
        currentPlayerId = null;
        currentPlayerName = '';
        localStorage.removeItem('current_player_id');
        document.getElementById('playerInterface').style.display = 'none';
        document.getElementById('playerSelectSection').style.display = 'block';
    } else if (data.type === 'gift_received') {
        // 收到卡牌
        addGameLog(`收到「${data.cardName}」`, 'draw');
    } else if (data.type === 'gift_result') {
        // 赠送结果反馈
        if (data.success) {
            addGameLog(`将「${data.cardName}」赠送给了${data.targetName}`, 'system');
            closeGiftPanel();
        } else {
            alert(data.message || '赠送失败');
        }
    }
}

function addGameLog(message, type = '') {
    const logContent = document.getElementById('logContent');
    if (!logContent) return;
    
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const logItem = document.createElement('div');
    logItem.className = 'log-item';
    logItem.innerHTML = `<span class="log-time">${time}</span><span class="log-msg ${type}">${message}</span>`;
    
    logContent.insertBefore(logItem, logContent.firstChild);
    
    // 限制日志数量
    while (logContent.children.length > 50) {
        logContent.removeChild(logContent.lastChild);
    }
}

function sendToHost(data) {
    if (peer && isConnected) {
        const conn = peer.connections[hostId];
        if (conn && conn[0]) {
            conn[0].send(data);
        }
    }
}

function disconnectNetwork() {
    if (peer) {
        peer.destroy();
        peer = null;
    }
    isConnected = false;
    hostId = '';
    updateNetworkStatus('offline');
    document.getElementById('joinRoomForm').style.display = 'flex';
    document.getElementById('onlineInfo').style.display = 'none';
    document.getElementById('roomIdInput').value = '';
    document.getElementById('connectionTip').style.display = 'block';
}

function updateNetworkStatus(status) {
    const statusDot = document.querySelector('#networkStatus .status-dot');
    const statusText = document.querySelector('#networkStatus .status-text');
    
    statusDot.className = 'status-dot ' + status;
    
    switch (status) {
        case 'online':
            statusText.textContent = '已连接';
            break;
        case 'connecting':
            statusText.textContent = '连接中...';
            break;
        default:
            statusText.textContent = '未连接';
    }
}

// ==================== 状态管理 ====================
function saveState() {
    // 玩家端不主动保存（由主持人广播数据）
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

// ==================== 玩家选择 ====================
function renderPlayerSelect() {
    document.getElementById('playerSelectSection').style.display = 'block';
    document.getElementById('playerInterface').style.display = 'none';
    
    const container = document.getElementById('playerButtons');
    
    if (players.length === 0) {
        container.innerHTML = '<div class="empty-hint">暂无玩家，请由主持人添加</div>';
        return;
    }
    
    container.innerHTML = players.map(player => {
        const isTaken = takenPlayerIds.includes(player.id) && player.id !== currentPlayerId;
        const isCurrentPlayer = player.id === currentPlayerId;
        const disabled = isTaken ? 'disabled' : '';
        const statusClass = isTaken ? 'taken' : (isCurrentPlayer ? 'selected' : '');
        const statusText = isTaken ? '（已占用）' : (isCurrentPlayer ? '（已选）' : '');
        
        return `
            <button class="btn btn-player ${statusClass}" onclick="selectPlayer('${player.id}')" ${disabled}>
                <span class="player-avatar-small">${player.name[0]}</span>
                ${player.name}
                <span class="hand-count">${player.hand.length}张</span>
                ${statusText}
            </button>
        `;
    }).join('');
}

function selectPlayer(playerId) {
    const player = players.find(p => p.id === playerId);
    if (!player) return;
    
    // 检查是否已被其他玩家选择
    if (takenPlayerIds.includes(playerId) && playerId !== currentPlayerId) {
        addGameLog(`「${player.name}」已被其他玩家选择`, 'system');
        return;
    }
    
    // 在线模式：发送选择请求给主持人
    if (isConnected) {
        sendToHost({ type: 'select_player', playerId: playerId });
    } else {
        // 离线模式：直接选择
        currentPlayerId = player.id;
        currentPlayerName = player.name;
        localStorage.setItem('current_player_id', playerId);
        showPlayerInterface();
    }
}

function showPlayerInterface() {
    document.getElementById('playerSelectSection').style.display = 'none';
    document.getElementById('playerInterface').style.display = 'block';
    document.getElementById('currentPlayerName').textContent = currentPlayerName;
    renderAll();
}

// ==================== 抽卡 ====================
function dealCardToMe() {
    const poolName = document.getElementById('drawPoolSelect').value;
    if (!poolName) return alert('请选择卡池');
    if (!cardPools[poolName] || cardPools[poolName].length === 0) return alert('该卡池已空');
    
    if (isConnected) {
        // 在线模式：发送抽卡请求给主持人
        sendToHost({
            type: 'draw_request',
            playerId: currentPlayerId,
            playerName: currentPlayerName,
            poolName: poolName
        });
    } else {
        // 离线模式：直接抽卡
        performDraw(poolName);
    }
}

function performDraw(poolName) {
    const player = players.find(p => p.id === currentPlayerId);
    if (!player) return;
    
    if (!cardPools[poolName] || cardPools[poolName].length === 0) {
        alert('该卡池已空');
        return;
    }
    
    const index = Math.floor(Math.random() * cardPools[poolName].length);
    const card = cardPools[poolName].splice(index, 1)[0];
    card.id = generateId();
    player.hand.push(card);
    
    lastSelectedPool = poolName;
    localStorage.setItem('last_pool', poolName);
    
    saveState();
    renderAll();
}

function updateDrawPoolSelect() {
    const select = document.getElementById('drawPoolSelect');
    if (!select) return;
    select.innerHTML = '<option value="">-- 选择卡池 --</option>';
    Object.keys(cardPools).forEach(name => {
        if (cardPools[name].length === 0) return;
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name + ' (' + cardPools[name].length + '张)';
        select.appendChild(opt);
    });
    
    if (lastSelectedPool && cardPools[lastSelectedPool] && cardPools[lastSelectedPool].length > 0) {
        select.value = lastSelectedPool;
    }
    
    updatePoolHint();
}

function updatePoolHint() {
    const poolName = document.getElementById('drawPoolSelect')?.value;
    const hint = document.getElementById('poolHint');
    if (!hint) return;
    
    if (!poolName) {
        hint.textContent = '选择卡池后点击抽卡';
        hint.style.display = 'block';
    } else if (!cardPools[poolName] || cardPools[poolName].length === 0) {
        hint.textContent = '该卡池已空';
        hint.style.display = 'block';
    } else {
        hint.style.display = 'none';
    }
}

// ==================== 手牌操作 ====================

// 显示赠送面板
function showGiftPanel() {
    selectedGiftCard = null;
    selectedGiftTarget = null;
    
    const player = players.find(p => p.id === currentPlayerId);
    if (!player || player.hand.length === 0) {
        alert('手牌为空，无法赠送');
        return;
    }
    
    // 渲染可赠送的卡牌
    const cardList = document.getElementById('giftCardList');
    cardList.innerHTML = player.hand.map(card => `
        <div class="card gift-card" data-card-id="${card.id}" data-card-name="${card.name}" onclick="selectGiftCard('${card.id}')">
            <div class="card-front">
                <img src="${card.image}" alt="${card.name}">
            </div>
            <div class="card-name">${card.name}</div>
        </div>
    `).join('');
    
    // 渲染可选目标玩家
    const targetList = document.getElementById('giftTargetList');
    const otherPlayers = players.filter(p => p.id !== currentPlayerId);
    
    if (otherPlayers.length === 0) {
        targetList.innerHTML = '<div class="empty-hint">没有其他玩家可赠送</div>';
    } else {
        targetList.innerHTML = otherPlayers.map(player => `
            <button class="btn btn-small gift-target-btn" data-player-id="${player.id}" onclick="selectGiftTarget('${player.id}')">
                ${player.name}
            </button>
        `).join('');
    }
    
    document.getElementById('giftCardHint').style.display = 'block';
    document.getElementById('giftTargetSection').style.display = 'none';
    document.getElementById('confirmGiftBtn').disabled = true;
    document.getElementById('giftPanel').style.display = 'flex';
}

// 选择要赠送的卡牌
function selectGiftCard(cardId) {
    const player = players.find(p => p.id === currentPlayerId);
    const card = player?.hand.find(c => c.id === cardId);
    if (!card) return;
    
    selectedGiftCard = card;
    
    // 高亮选中的卡牌
    document.querySelectorAll('.gift-card').forEach(el => {
        el.classList.remove('selected');
        if (el.dataset.cardId === cardId) {
            el.classList.add('selected');
        }
    });
    
    document.getElementById('giftCardHint').style.display = 'none';
    document.getElementById('giftTargetSection').style.display = 'block';
    
    // 如果已选择目标玩家，启用确认按钮
    updateGiftConfirmBtn();
}

// 选择目标玩家
function selectGiftTarget(playerId) {
    selectedGiftTarget = players.find(p => p.id === playerId);
    
    // 高亮选中的目标
    document.querySelectorAll('.gift-target-btn').forEach(el => {
        el.classList.remove('selected');
        if (el.dataset.playerId === playerId) {
            el.classList.add('selected');
        }
    });
    
    updateGiftConfirmBtn();
}

// 更新确认按钮状态
function updateGiftConfirmBtn() {
    const btn = document.getElementById('confirmGiftBtn');
    btn.disabled = !(selectedGiftCard && selectedGiftTarget);
}

// 确认赠送
function confirmGift() {
    if (!selectedGiftCard || !selectedGiftTarget) {
        alert('请选择卡牌和目标玩家');
        return;
    }
    
    if (isConnected) {
        // 在线模式：发送赠送请求给主持人
        sendToHost({
            type: 'gift_card',
            fromPlayerId: currentPlayerId,
            fromPlayerName: currentPlayerName,
            toPlayerId: selectedGiftTarget.id,
            toPlayerName: selectedGiftTarget.name,
            cardId: selectedGiftCard.id,
            cardName: selectedGiftCard.name
        });
    } else {
        // 离线模式：直接执行赠送
        performGiftCard(selectedGiftTarget.id);
    }
}

// 执行赠送（离线模式）
function performGiftCard(toPlayerId) {
    const fromPlayer = players.find(p => p.id === currentPlayerId);
    const toPlayer = players.find(p => p.id === toPlayerId);
    
    if (!fromPlayer || !toPlayer) {
        alert('玩家不存在');
        return;
    }
    
    if (!selectedGiftCard) {
        alert('请选择要赠送的卡牌');
        return;
    }
    
    const cardIndex = fromPlayer.hand.findIndex(c => c.id === selectedGiftCard.id);
    if (cardIndex === -1) {
        alert('卡牌不在手牌中');
        return;
    }
    
    // 从发送方手牌移除
    fromPlayer.hand.splice(cardIndex, 1);
    // 添加到接收方手牌
    toPlayer.hand.push(selectedGiftCard);
    
    saveState();
    renderAll();
    addGameLog(`将「${selectedGiftCard.name}」赠送给了${toPlayer.name}`, 'system');
    closeGiftPanel();
}

// 关闭赠送面板
function closeGiftPanel() {
    document.getElementById('giftPanel').style.display = 'none';
    selectedGiftCard = null;
    selectedGiftTarget = null;
}

function useCard(cardId) {
    if (isConnected) {
        sendToHost({
            type: 'use_card',
            playerId: currentPlayerId,
            cardId: cardId
        });
    } else {
        performUseCard(cardId);
    }
}

function performUseCard(cardId) {
    const player = players.find(p => p.id === currentPlayerId);
    if (!player) return;
    
    const index = player.hand.findIndex(c => c.id === cardId);
    if (index === -1) return;
    
    const card = player.hand.splice(index, 1)[0];
    tableCards.push({ card, playerName: currentPlayerName });
    
    saveState();
    renderAll();
}

function discardCard(cardId) {
    if (isConnected) {
        sendToHost({
            type: 'discard_card',
            playerId: currentPlayerId,
            cardId: cardId
        });
    } else {
        performDiscardCard(cardId);
    }
}

function performDiscardCard(cardId) {
    const player = players.find(p => p.id === currentPlayerId);
    if (!player) return;
    
    const index = player.hand.findIndex(c => c.id === cardId);
    if (index === -1) return;
    
    const card = player.hand.splice(index, 1)[0];
    discardPile.push(card);
    
    saveState();
    renderAll();
}

function discardLastCard() {
    const player = players.find(p => p.id === currentPlayerId);
    if (!player || player.hand.length === 0) return alert('手牌为空');
    
    const cardId = player.hand[player.hand.length - 1].id;
    
    if (isConnected) {
        sendToHost({
            type: 'discard_card',
            playerId: currentPlayerId,
            cardId: cardId
        });
    } else {
        performDiscardCard(cardId);
    }
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

// ==================== 渲染 ====================
function renderAll() {
    updateDrawPoolSelect();
    renderPlayerHand();
    renderTable();
    renderDiscardPile();
    updatePoolHint();
}

function renderPlayerHand() {
    const container = document.getElementById('playerHandArea');
    if (!container) return;
    const player = players.find(p => p.id === currentPlayerId);
    
    if (!player || player.hand.length === 0) {
        container.innerHTML = '<div class="empty-hint">暂无手牌，请等待主持人发牌</div>';
        return;
    }
    
    container.innerHTML = player.hand.map(card => `
        <div class="card">
            <div class="card-front" onclick="enlargeCard('${card.image}', '${card.name}')">
                <img src="${card.image}" alt="${card.name}">
            </div>
            <div class="card-name">${card.name}</div>
            <div class="card-actions">
                <button class="card-action" style="background:#27ae60" onclick="useCard('${card.id}')" title="使用">用</button>
                <button class="card-action discard" onclick="discardCard('${card.id}')" title="弃牌">×</button>
            </div>
        </div>
    `).join('');
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
        container.className = '';
        container.innerHTML = '<span class="empty-hint">弃牌堆为空</span>';
        return;
    }
    
    container.className = '';
    container.innerHTML = discardPile.map(card => `
        <div class="card mini-card" onclick="enlargeCard('${card.image}', '${card.name}')">
            <div class="card-front"><img src="${card.image}" alt="${card.name}"></div>
            <div class="card-name">${card.name}</div>
        </div>
    `).join('');
}

// ==================== 工具函数 ====================
function generateId() {
    return 'id_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// ==================== 清除数据 ====================
function clearPlayerData() {
    if (!confirm('确定要清除数据并退出当前角色吗？此操作不可恢复！')) return;
    
    const playerName = currentPlayerName;
    
    // 清除当前玩家的手牌
    const player = players.find(p => p.id === currentPlayerId);
    if (player) {
        player.hand = [];
    }
    
    // 清除玩家的本地存储数据
    localStorage.removeItem('game_data');
    localStorage.removeItem('current_player_id');
    
    // 重置状态
    currentPlayerId = null;
    currentPlayerName = '';
    cardPools = {};
    tableCards = [];
    discardPile = [];
    
    // 保存状态
    saveState();
    
    // 隐藏玩家界面，显示选择界面
    document.getElementById('playerInterface').style.display = 'none';
    document.getElementById('playerSelectSection').style.display = 'block';
    document.getElementById('gameLog').style.display = 'none';
    document.getElementById('connectionTip').style.display = 'block';
    document.getElementById('joinRoomForm').style.display = 'flex';
    document.getElementById('onlineInfo').style.display = 'none';
    
    // 在线模式：通知主持人释放角色
    if (isConnected && currentPlayerId) {
        sendToHost({ type: 'quit_player', playerId: currentPlayerId });
    }
    
    // 重置网络状态
    disconnectNetwork();
    
    // 重置 takenPlayerIds
    takenPlayerIds = [];
    
    // 重新渲染玩家按钮
    renderPlayerSelect();
    
    addGameLog(`已退出角色：${playerName}`, 'system');
}
