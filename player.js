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

// ==================== 自定义提示弹窗 ====================
function showToast(message) {
    document.getElementById('toastMessage').textContent = message;
    document.getElementById('toastModal').classList.add('active');
}

function closeToast() {
    document.getElementById('toastModal').classList.remove('active');
}

// ==================== 自定义确认弹窗 ====================
let confirmCallback = null;

function showConfirm(message, onConfirm) {
    document.getElementById('confirmMessage').textContent = message;
    confirmCallback = onConfirm;
    document.getElementById('confirmModal').classList.add('active');
}

function closeConfirm() {
    document.getElementById('confirmModal').classList.remove('active');
    confirmCallback = null;
}

function confirmAction() {
    if (confirmCallback) {
        const cb = confirmCallback;
        closeConfirm();
        cb();
    }
}

// ==================== 初始化 ====================
window.addEventListener('load', () => {
    loadState();
    initEventListeners();
    initPlayerBattlefieldZoom();  // 初始化玩家战场缩放功能
    
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
        showToast('请输入房间号');
        return;
    }
    
    if (peer) {
        showToast('已在房间中');
        return;
    }
    
    updateNetworkStatus('connecting');
    
    peer = new Peer({
        debug: 1,
        config: {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' }
            ]
        }
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
            showToast('与主持人断开连接');
        });
        
        conn.on('error', (err) => {
            console.error('连接错误:', err);
            showToast('连接失败，请检查房间号是否正确');
            updateNetworkStatus('offline');
        });
    });
    
    peer.on('error', (err) => {
        console.error('PeerJS错误:', err);
        if (err.type === 'peer-unavailable') {
            showToast('房间不存在或主持人已断开');
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
            // 保存当前选择的卡池
            if (data.poolName) {
                lastSelectedPool = data.poolName;
                localStorage.setItem('last_pool', data.poolName);
            }
        }
    } else if (data.type === 'game_log') {
        // 只显示与当前玩家相关的日志
        if (data.message.includes(currentPlayerName)) {
            addGameLog(data.message, data.logType);
        }
    } else if (data.type === 'kicked') {
        // 被主持人踢出
        addGameLog('你被主持人移出了角色', 'warning');
        showToast('你被主持人移出了当前角色，可以重新选择其他角色');
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
            showToast(data.message || '赠送失败');
        }
    } else if (data.type && data.type.startsWith('battle-')) {
        handleBattleMessage(data);
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
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    
    if (statusDot) statusDot.className = 'status-dot ' + status;
    
    if (statusText) {
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
    if (!poolName) return showToast('请选择卡池');
    if (!cardPools[poolName] || cardPools[poolName].length === 0) return showToast('该卡池已空');
    
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
        showToast('该卡池已空');
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
    // 检查是否已连接房间
    if (!isConnected) {
        showToast('请先加入房间后再赠送卡牌');
        return;
    }
    
    selectedGiftCard = null;
    selectedGiftTarget = null;
    
    const player = players.find(p => p.id === currentPlayerId);
    if (!player || player.hand.length === 0) {
        showToast('手牌为空，无法赠送');
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
        showToast('请选择卡牌和目标玩家');
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
        // 离线模式：不允许赠送
        showToast('离线模式下无法赠送卡牌，请先加入房间');
        closeGiftPanel();
    }
}

// 执行赠送（离线模式）
function performGiftCard(toPlayerId) {
    const fromPlayer = players.find(p => p.id === currentPlayerId);
    const toPlayer = players.find(p => p.id === toPlayerId);
    
    if (!fromPlayer || !toPlayer) {
        showToast('玩家不存在');
        return;
    }
    
    if (!selectedGiftCard) {
        showToast('请选择要赠送的卡牌');
        return;
    }
    
    const cardIndex = fromPlayer.hand.findIndex(c => c.id === selectedGiftCard.id);
    if (cardIndex === -1) {
        showToast('卡牌不在手牌中');
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
    if (!player || player.hand.length === 0) return showToast('手牌为空');
    
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
    // 更新战场卡牌面板
    if (currentBattleState) {
        playerBattleCards = [];
        const player = players.find(p => p.id === currentPlayerId);
        if (player) {
            playerBattleCards = [...player.hand];
        }
        renderPlayerBattleCardsPanel();
    }
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

// ==================== 战场系统 ====================
let battleRoomList = [];          // 主机广播的战场列表
let currentBattleId = null;       // 当前查看的战场ID
let currentBattleState = null;    // 当前战场的完整状态
let playerBattleSelectedCard = null;
let playerBattleSelectedToken = null;
let isInBattle = false;           // 是否已加入当前战场
let playerBattleCards = [];       // 可用卡牌列表

// 处理战场相关消息
function handleBattleMessage(data) {
    if (data.type === 'battle-list') {
        battleRoomList = data.battleRooms || [];
        renderPlayerBattleRooms();

        // 如果当前不在任何战场且战场列表不为空，显示选择按钮
        if (!currentBattleId && battleRoomList.length > 0) {
            document.getElementById('playerBattleRooms').style.display = 'flex';
            document.getElementById('playerBattleEmpty').style.display = 'none';
        }

    } else if (data.type === 'battle-state') {
        // 无论是否当前查看，都更新战场状态（保持同步）
        if (data.battleId === currentBattleId) {
            currentBattleState = data.data;
            renderPlayerBattlefield();
        }
        // 如果当前不在任何战场且收到战场状态，也更新列表显示
        if (!currentBattleId) {
            const existingRoom = battleRoomList.find(r => r.id === data.battleId);
            if (!existingRoom && data.data) {
                battleRoomList.push({ id: data.battleId, name: data.data.name || '战场' });
                renderPlayerBattleRooms();
            }
        }

    } else if (data.type === 'battle-place-result') {
        if (data.success) {
            playerCancelPlaceMode();
        } else {
            showToast(data.message || '放置失败');
        }

    } else if (data.type === 'battle-move-result') {
        // 移动结果，状态已通过 broadcastBattleState 更新

    } else if (data.type === 'battle-remove-result') {
        if (data.success) {
            playerBattleSelectedToken = null;
            document.getElementById('playerTokenActionsPanel').classList.remove('active');
        }
    }
}

// 渲染战场房间选择按钮
function renderPlayerBattleRooms() {
    const container = document.getElementById('playerBattleRooms');
    if (!container) return;

    if (battleRoomList.length === 0) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'flex';
    container.innerHTML = battleRoomList.map(room => `
        <button class="player-battle-room-btn ${currentBattleId === room.id ? 'active' : ''}" onclick="switchPlayerBattle('${room.id}')">
            ${room.name}
        </button>
    `).join('');
}

// 切换查看的战场
function switchPlayerBattle(battleId) {
    currentBattleId = battleId;
    isInBattle = false;

    document.getElementById('btnJoinBattle').style.display = 'inline-block';
    document.getElementById('btnLeaveBattle').style.display = 'none';

    // 请求战场状态
    sendToHost({ type: 'battle-join', battleId });
    renderPlayerBattleRooms();

    // 清空战场显示
    document.getElementById('playerBattlefieldGrid').innerHTML = '';
    document.getElementById('playerBattleEmpty').style.display = 'none';
    document.getElementById('playerTokenActionsPanel').classList.remove('active');
    playerCancelPlaceMode();
}

// 加入当前战场
function joinCurrentBattle() {
    if (!currentBattleId) return;
    isInBattle = true;
    document.getElementById('btnJoinBattle').style.display = 'none';
    document.getElementById('btnLeaveBattle').style.display = 'inline-block';
    sendToHost({
        type: 'player-join',
        name: currentPlayerName,
        battleId: currentBattleId
    });
    addGameLog('加入了战场', 'system');
    // 请求完整状态
    sendToHost({ type: 'battle-join', battleId: currentBattleId });
}

// 离开战场
function leaveCurrentBattle() {
    if (!currentBattleId) return;
    isInBattle = false;
    document.getElementById('btnJoinBattle').style.display = 'inline-block';
    document.getElementById('btnLeaveBattle').style.display = 'none';
    sendToHost({ type: 'player-leave', battleId: currentBattleId });
    addGameLog('离开了战场', 'system');
    playerDeselectBattleToken();
    playerCancelPlaceMode();
}

// 渲染玩家端战场
function renderPlayerBattlefield() {
    if (!currentBattleState) return;
    const settings = currentBattleState.mapSettings || {};
    const tokens = currentBattleState.tokens || [];

    // 收集所有手牌中的卡牌作为可用卡牌
    playerBattleCards = [];
    const player = players.find(p => p.id === currentPlayerId);
    if (player) {
        player.hand.forEach(card => {
            playerBattleCards.push(card);
        });
    }

    const grid = document.getElementById('playerBattlefieldGrid');
    const width = settings.width || 8;
    const height = settings.height || 6;
    const cellSize = settings.cellSize || 60;
    const bgColor = settings.bgColor || '#2c3e50';
    const gridColor = settings.gridColor || '#34495e';
    const bgImage = settings.backgroundImage;

    grid.style.gridTemplateColumns = `repeat(${width}, ${cellSize}px)`;
    grid.style.background = gridColor;

    // 使用DocumentFragment优化
    const fragment = document.createDocumentFragment();
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const cell = document.createElement('div');
            cell.className = 'battlefield-cell' + (bgImage ? ' bg-image' : '');
            cell.dataset.x = x;
            cell.dataset.y = y;
            let cellStyle = `background:${bgColor};width:${cellSize}px;height:${cellSize}px;`;
            if (bgImage) {
                cellStyle = `background-color:${bgColor};background-image:url(${bgImage});background-size:${width * cellSize}px ${height * cellSize}px;background-position:-${x * cellSize}px -${y * cellSize}px;width:${cellSize}px;height:${cellSize}px;`;
            }
            cell.style.cssText = cellStyle;
            cell.onclick = () => onPlayerBattleCellClick(x, y);
            cell.ondragover = (e) => { e.preventDefault(); cell.classList.add('drag-over'); };
            cell.ondragleave = () => cell.classList.remove('drag-over');
            cell.ondrop = (e) => onPlayerBattleCellDrop(e, x, y);
            fragment.appendChild(cell);
        }
    }
    grid.innerHTML = '';
    grid.appendChild(fragment);

    // 渲染 Token
    tokens.forEach(token => {
        const cell = grid.querySelector(`.battlefield-cell[data-x="${token.x}"][data-y="${token.y}"]`);
        if (!cell) return;

        const canDrag = isInBattle && token.ownerId === peer?.id;
        const isOwnToken = token.ownerId === peer?.id;

        const el = document.createElement('div');
        el.className = 'battle-token' + (playerBattleSelectedToken && playerBattleSelectedToken.id === token.id ? ' selected' : '') + (token.flipped && !isOwnToken ? ' flipped' : '');
        if (canDrag) el.draggable = true;
        el.dataset.tokenId = token.id;

        let imgHtml = '';
        if (token.flipped && !isOwnToken) {
            imgHtml = `<img src="${token.cardImage}" alt="${token.cardName}" style="filter:blur(5px);">`;
        } else {
            imgHtml = `<img src="${token.cardImage}" alt="${token.cardName}" style="transform:rotate(${token.rotation}deg);">`;
        }

        el.innerHTML = `
            <div class="battle-token-owner">${token.ownerName}</div>
            ${imgHtml}
            <div class="battle-token-name">${token.cardName}</div>
            ${token.rotation !== 0 && !(token.flipped && !isOwnToken) ? `<div class="rotation-badge">↻</div>` : ''}
        `;

        if (canDrag) {
            el.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', token.id);
                e.dataTransfer.effectAllowed = 'move';
            });
        }

        cell.classList.add('has-token');
        cell.appendChild(el);
    });

    document.getElementById('playerBattleEmpty').style.display = 'none';
}

// ==================== 玩家端战场缩放功能 ====================
let playerBattlefieldZoom = 1;
const PLAYER_MIN_ZOOM = 0.3;
const PLAYER_MAX_ZOOM = 3;
let playerIsPanning = false;
let playerPanStartX = 0, playerPanStartY = 0;
let playerPanStartScrollLeft = 0, playerPanStartScrollTop = 0;

function initPlayerBattlefieldZoom() {
    const scrollContainer = document.getElementById('playerBattlefieldScroll');
    const zoomContainer = document.getElementById('playerBattlefieldZoomContainer');
    if (!scrollContainer || !zoomContainer) return;

    // 触摸拖动/平移
    scrollContainer.addEventListener('mousedown', (e) => {
        if (e.target.closest('.battle-token')) return;
        playerIsPanning = true;
        playerPanStartX = e.clientX;
        playerPanStartY = e.clientY;
        playerPanStartScrollLeft = scrollContainer.scrollLeft;
        playerPanStartScrollTop = scrollContainer.scrollTop;
        scrollContainer.style.cursor = 'grabbing';
    });

    scrollContainer.addEventListener('touchstart', (e) => {
        if (e.target.closest('.battle-token')) return;
        if (e.touches.length === 1) {
            playerIsPanning = true;
            playerPanStartX = e.touches[0].clientX;
            playerPanStartY = e.touches[0].clientY;
            playerPanStartScrollLeft = scrollContainer.scrollLeft;
            playerPanStartScrollTop = scrollContainer.scrollTop;
        }
    }, { passive: true });

    document.addEventListener('mousemove', (e) => {
        if (!playerIsPanning) return;
        scrollContainer.scrollLeft = playerPanStartScrollLeft + (playerPanStartX - e.clientX);
        scrollContainer.scrollTop = playerPanStartScrollTop + (playerPanStartY - e.clientY);
    });

    document.addEventListener('touchmove', (e) => {
        if (!playerIsPanning) return;
        if (e.touches.length === 1) {
            scrollContainer.scrollLeft = playerPanStartScrollLeft + (playerPanStartX - e.touches[0].clientX);
            scrollContainer.scrollTop = playerPanStartScrollTop + (playerPanStartY - e.touches[0].clientY);
        }
    }, { passive: true });

    document.addEventListener('mouseup', () => {
        playerIsPanning = false;
        scrollContainer.style.cursor = '';
    });

    document.addEventListener('touchend', () => {
        playerIsPanning = false;
    });

    // 滚轮缩放（PC端）
    scrollContainer.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        applyPlayerBattlefieldZoom(playerBattlefieldZoom * delta);
    }, { passive: false });

    // 双指缩放（手机端）
    let lastPinchDistance = 0;
    scrollContainer.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2 && !e.target.closest('.battle-token')) {
            const distance = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            if (lastPinchDistance > 0) {
                const scale = distance / lastPinchDistance;
                applyPlayerBattlefieldZoom(playerBattlefieldZoom * scale);
            }
            lastPinchDistance = distance;
        }
    }, { passive: true });

    scrollContainer.addEventListener('touchend', () => {
        lastPinchDistance = 0;
    });
}

function applyPlayerBattlefieldZoom(newZoom) {
    const zoomContainer = document.getElementById('playerBattlefieldZoomContainer');
    const zoomLevelDisplay = document.getElementById('playerZoomLevelDisplay');
    if (!zoomContainer) return;

    playerBattlefieldZoom = Math.max(PLAYER_MIN_ZOOM, Math.min(PLAYER_MAX_ZOOM, newZoom));
    zoomContainer.style.transform = `scale(${playerBattlefieldZoom})`;
    
    if (zoomLevelDisplay) {
        zoomLevelDisplay.textContent = Math.round(playerBattlefieldZoom * 100) + '%';
    }
}

function playerZoomBattlefield(delta) {
    applyPlayerBattlefieldZoom(playerBattlefieldZoom + delta);
}

function resetPlayerBattlefieldZoom() {
    applyPlayerBattlefieldZoom(1);
}

// 战场卡牌面板
function togglePlayerBattleCards() {
    const panel = document.getElementById('playerBattleCardsPanel');
    const isVisible = panel.style.display !== 'none';
    panel.style.display = isVisible ? 'none' : 'block';
    if (!isVisible) {
        renderPlayerBattleCardsPanel();
    }
}

function renderPlayerBattleCardsPanel() {
    const container = document.getElementById('playerBattleCardsGrid');
    if (!container) return;

    if (playerBattleCards.length === 0) {
        container.innerHTML = '<div style="color:#ccc;font-size:12px;">暂无可用手牌</div>';
        return;
    }

    container.innerHTML = playerBattleCards.map(card => `
        <div class="battle-card-option ${playerBattleSelectedCard && playerBattleSelectedCard.id === card.id ? 'selected' : ''}" onclick="selectPlayerBattleCard('${card.id}')">
            <img src="${card.image}" alt="${card.name}">
            <div class="card-option-name">${card.name}</div>
        </div>
    `).join('');
}

function selectPlayerBattleCard(cardId) {
    const card = playerBattleCards.find(c => c.id === cardId);
    if (!card) return;

    if (playerBattleSelectedCard && playerBattleSelectedCard.id === cardId) {
        playerCancelPlaceMode();
        return;
    }

    playerBattleSelectedCard = card;
    playerBattleSelectedToken = null;
    document.getElementById('playerTokenActionsPanel').classList.remove('active');

    document.getElementById('playerPlaceModeHint').style.display = 'block';
    document.getElementById('playerPlaceModeCardName').textContent = card.name;
    renderPlayerBattleCardsPanel();
}

function playerCancelPlaceMode() {
    playerBattleSelectedCard = null;
    document.getElementById('playerPlaceModeHint').style.display = 'none';
    renderPlayerBattleCardsPanel();
}

// 玩家点击战场格子
function onPlayerBattleCellClick(x, y) {
    if (!isInBattle || !currentBattleState) return;

    // 放置卡牌
    if (playerBattleSelectedCard) {
        const token = {
            cardId: playerBattleSelectedCard.id,
            cardName: playerBattleSelectedCard.name,
            cardImage: playerBattleSelectedCard.image,
            x: x,
            y: y,
            rotation: 0,
            flipped: false
        };
        sendToHost({
            type: 'battle-place-token',
            token,
            cardId: playerBattleSelectedCard.id,
            name: currentPlayerName,
            playerPeerId: peer?.id,
            battleId: currentBattleId
        });
        return;
    }

    // 检查是否点击了 Token（玩家只能操作自己的token）
    const clickedToken = currentBattleState.tokens?.find(t => t.x === x && t.y === y);
    if (clickedToken && clickedToken.ownerId === peer?.id) {
        playerSelectBattleToken(clickedToken);
    } else {
        playerDeselectBattleToken();
    }
}

// Token 操作
function playerSelectBattleToken(token) {
    playerBattleSelectedToken = token;
    playerBattleSelectedCard = null;
    document.getElementById('playerPlaceModeHint').style.display = 'none';
    renderPlayerBattleCardsPanel();

    const panel = document.getElementById('playerTokenActionsPanel');
    panel.classList.add('active');
    document.getElementById('playerTokenPreviewImg').src = token.cardImage;
    document.getElementById('playerTokenPreviewName').textContent = token.cardName;
    document.getElementById('playerTokenPreviewOwner').textContent = `位置: (${token.x}, ${token.y})`;

    renderPlayerBattlefield();
}

function playerDeselectBattleToken() {
    playerBattleSelectedToken = null;
    document.getElementById('playerTokenActionsPanel').classList.remove('active');
    renderPlayerBattlefield();
}

function playerRotateBattleToken() {
    if (!playerBattleSelectedToken || !currentBattleId) return;
    const newRotation = (playerBattleSelectedToken.rotation + 90) % 360;
    playerBattleSelectedToken.rotation = newRotation;
    sendToHost({
        type: 'rotate-token',
        tokenId: playerBattleSelectedToken.id,
        rotation: newRotation,
        playerPeerId: peer?.id,
        battleId: currentBattleId
    });
    renderPlayerBattlefield();
}

function playerFlipBattleToken() {
    if (!playerBattleSelectedToken || !currentBattleId) return;
    const newFlipped = !playerBattleSelectedToken.flipped;
    playerBattleSelectedToken.flipped = newFlipped;
    sendToHost({
        type: 'flip-token',
        tokenId: playerBattleSelectedToken.id,
        flipped: newFlipped,
        playerPeerId: peer?.id,
        battleId: currentBattleId
    });
    renderPlayerBattlefield();
}

function playerRemoveBattleToken() {
    if (!playerBattleSelectedToken || !currentBattleId) return;
    showPlayerConfirm('确定删除该 Token 吗？', () => {
        sendToHost({
            type: 'remove-token',
            tokenId: playerBattleSelectedToken.id,
            playerPeerId: peer?.id,
            battleId: currentBattleId
        });
        playerBattleSelectedToken = null;
        document.getElementById('playerTokenActionsPanel').classList.remove('active');
    });
}

// 玩家端拖拽
function onPlayerBattleCellDrop(event, x, y) {
    event.preventDefault();
    event.currentTarget.classList.remove('drag-over');
    if (!isInBattle || !currentBattleId) return;

    const tokenId = event.dataTransfer.getData('text/plain');
    if (!tokenId) return;

    sendToHost({
        type: 'battle-move-token',
        tokenId,
        x,
        y,
        playerPeerId: peer?.id,
        battleId: currentBattleId
    });
}

// 玩家端确认弹窗（使用全局确认框）
function showPlayerConfirm(message, onConfirm) {
    showConfirm(message, onConfirm);
}

// 玩家端战场日志
function addPlayerBattleLog(message) {
    const container = document.getElementById('playerBattleLog');
    if (!container) return;
    container.style.display = 'block';
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const item = document.createElement('div');
    item.className = 'battle-log-item';
    item.innerHTML = `<span class="battle-log-time">${time}</span>${message}`;
    container.insertBefore(item, container.firstChild);
    while (container.children.length > 30) {
        container.removeChild(container.lastChild);
    }
}

// ==================== 清除数据 ====================
function clearPlayerData() {
    showConfirm('确定要清除数据并退出当前角色吗？此操作不可恢复！', () => {
    
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
    });
}
