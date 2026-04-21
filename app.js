// ==================== IndexedDB 存储系统 ====================
const DB_NAME = 'CardGameDB_Local';
const DB_VERSION = 1;
const STORE_CARDS = 'cards';
const STORE_IMAGES = 'images';

// 图片压缩配置
const IMAGE_CONFIG = {
    maxWidth: 800,      // 最大宽度
    maxHeight: 800,     // 最大高度
    quality: 0.7,       // 压缩质量 0-1
    maxSizeKB: 50       // 单张图片最大 KB
};

let db = null;

// ==================== 图片压缩功能 ====================
async function compressImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                let { width, height } = img;
                
                if (width > IMAGE_CONFIG.maxWidth) {
                    height = Math.round(height * IMAGE_CONFIG.maxWidth / width);
                    width = IMAGE_CONFIG.maxWidth;
                }
                if (height > IMAGE_CONFIG.maxHeight) {
                    width = Math.round(width * IMAGE_CONFIG.maxHeight / height);
                    height = IMAGE_CONFIG.maxHeight;
                }
                
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                
                let quality = IMAGE_CONFIG.quality;
                const minQuality = 0.3;
                
                const tryCompress = () => {
                    const dataUrl = canvas.toDataURL('image/jpeg', quality);
                    const sizeKB = Math.round(dataUrl.length * 0.75 / 1024);
                    
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
            
            if (!database.objectStoreNames.contains(STORE_CARDS)) {
                database.createObjectStore(STORE_CARDS, { keyPath: 'id' });
            }
            
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

// 保存卡牌数据
async function saveCardsToDB(cards) {
    if (!db) await initDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_CARDS], 'readwrite');
        const store = transaction.objectStore(STORE_CARDS);
        store.clear();
        cards.forEach(card => store.put(card));
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

// ==================== 数据结构 ====================
let cardPools = {};  // { poolName: [{id, name, imageId}] }
let playerHand = []; // [{id, name, image}]
let tableCards = [];  // [{card, playerName}]
let discardPile = []; // [{id, name, image}]

let discardSelectMode = false;
let selectedDiscardCards = [];

// ==================== 初始化 ====================
document.getElementById('uploadImgs').addEventListener('change', handleImageUpload);

window.addEventListener('load', async () => {
    await initDB();
    await loadState();
    renderAll();
    document.querySelector('.modal-close').addEventListener('click', closeModal);
    document.getElementById('cardModal').addEventListener('click', (e) => {
        if (e.target === document.getElementById('cardModal')) closeModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
    });
});

// ==================== 状态管理 ====================
async function saveState() {
    localStorage.setItem('桌游_state', JSON.stringify({
        cardPools: {}, // 不存卡池具体数据
        playerHand, tableCards, discardPile
    }));
    
    // 分离存储卡池数据和图片
    const cardsToSave = [];
    const imagesToSave = [];
    
    for (const poolName of Object.keys(cardPools)) {
        for (const card of cardPools[poolName]) {
            cardsToSave.push({
                id: card.id,
                name: card.name,
                poolName: poolName
            });
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
}

async function loadState() {
    const saved = localStorage.getItem('桌游_state');
    if (saved) {
        const state = JSON.parse(saved);
        playerHand = state.playerHand || [];
        tableCards = state.tableCards || [];
        discardPile = state.discardPile || [];
    }
    
    try {
        const savedCards = await loadCardsFromDB();
        cardPools = {};
        
        for (const card of savedCards) {
            if (!card.poolName) continue;
            if (!cardPools[card.poolName]) {
                cardPools[card.poolName] = [];
            }
            const imageData = await getImageFromDB(card.id);
            cardPools[card.poolName].push({
                id: card.id,
                name: card.name,
                image: imageData
            });
        }
        
        // 加载手牌图片
        for (const card of playerHand) {
            if (!card.image) {
                card.image = await getImageFromDB(card.id);
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
    } catch (e) {
        console.error('加载卡牌数据失败:', e);
    }
}

async function clearLocalStorage() {
    if (!confirm('确定要清除所有本地记录吗？此操作不可恢复！')) return;
    localStorage.removeItem('桌游_state');
    cardPools = {};
    playerHand = [];
    tableCards = [];
    discardPile = [];
    
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
    alert('已清除所有本地记录');
}

// ==================== 卡池管理 ====================
function createPool() {
    const name = document.getElementById('poolNameInput').value.trim();
    if (!name) return alert('请输入卡池名称');
    if (cardPools[name]) return alert('卡池已存在');
    cardPools[name] = [];
    document.getElementById('poolNameInput').value = '';
    saveState();
    renderAll();
}

async function deletePool(poolName) {
    if (!confirm(`确定删除卡池"${poolName}"吗？`)) return;
    
    const cardsToDelete = cardPools[poolName] || [];
    for (const card of cardsToDelete) {
        await deleteImageFromDB(card.id);
    }
    
    delete cardPools[poolName];
    
    // 更新 IndexedDB
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
}

function updatePoolSelect() {
    const select = document.getElementById('targetPoolSelect');
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
    alert(`已上传 ${addedCount} 张图片 (共${totalSize}KB) 到「${poolName}」`);
    e.target.value = '';
}

// ==================== 手牌操作 ====================
function drawCard(poolName) {
    if (!cardPools[poolName] || cardPools[poolName].length === 0) {
        alert('该卡池已空');
        return;
    }
    const index = Math.floor(Math.random() * cardPools[poolName].length);
    const card = cardPools[poolName].splice(index, 1)[0];
    card.id = generateId(); // 重新生成ID避免冲突
    playerHand.push(card);
    saveState();
    renderAll();
}

function useCard(cardId) {
    const index = playerHand.findIndex(c => c.id === cardId);
    if (index === -1) return;
    const card = playerHand.splice(index, 1)[0];
    tableCards.push({ card, playerName: '我' });
    saveState();
    renderAll();
}

function giftCard(cardId) {
    // 本地模式：提示而已
    alert('本地模式下无法赠送，请使用在线版本');
}

function discardCard(cardId) {
    const index = playerHand.findIndex(c => c.id === cardId);
    if (index === -1) return;
    const card = playerHand.splice(index, 1)[0];
    discardPile.push(card);
    saveState();
    renderAll();
}

function discardSelected() {
    if (playerHand.length === 0) return alert('手牌为空');
    // 弃置最后一张
    const card = playerHand.pop();
    discardPile.push(card);
    saveState();
    renderAll();
}

// ==================== 桌面操作 ====================
function takeBackCard(index) {
    const cardObj = tableCards.splice(index, 1)[0];
    playerHand.push(cardObj.card);
    saveState();
    renderAll();
}

// ==================== 弃牌堆操作 ====================
function toggleDiscardSelect() {
    discardSelectMode = !discardSelectMode;
    selectedDiscardCards = [];
    
    document.getElementById('discardArea').classList.toggle('select-mode', discardSelectMode);
    document.querySelector('#discardArea + .area .btn-secondary')?.style.setProperty('display', discardSelectMode ? 'none' : 'inline-block');
    
    const recoverBtn = document.getElementById('recoverBtn');
    const cancelBtn = document.getElementById('cancelDiscardBtn');
    recoverBtn.style.display = discardSelectMode ? 'inline-block' : 'none';
    cancelBtn.style.display = discardSelectMode ? 'inline-block' : 'none';
    
    renderDiscardPile();
}

function cancelDiscardSelect() {
    discardSelectMode = false;
    selectedDiscardCards = [];
    document.getElementById('discardArea').classList.remove('select-mode');
    document.getElementById('recoverBtn').style.display = 'none';
    document.getElementById('cancelDiscardBtn').style.display = 'none';
    renderDiscardPile();
}

function recoverToHand() {
    if (selectedDiscardCards.length === 0) return alert('请选择要回收的卡牌');
    selectedDiscardCards.forEach(id => {
        const index = discardPile.findIndex(c => c.id === id);
        if (index > -1) {
            playerHand.push(discardPile.splice(index, 1)[0]);
        }
    });
    cancelDiscardSelect();
    saveState();
    renderAll();
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
    updatePoolSelect();
    renderCardPools();
    renderPlayerHand();
    renderTable();
    renderDiscardPile();
}

function renderCardPools() {
    const container = document.getElementById('cardPoolsArea');
    container.innerHTML = '';
    
    if (Object.keys(cardPools).length === 0) {
        container.innerHTML = '<div class="empty-hint" style="width:100%;text-align:center;">暂无卡池，请先创建</div>';
        return;
    }
    
    Object.keys(cardPools).forEach(poolName => {
        const pool = cardPools[poolName];
        const div = document.createElement('div');
        div.className = 'pool-box';
        
        div.innerHTML = `
            <div class="pool-header">
                <span class="pool-title">${poolName} (${pool.length})</span>
                <div>
                    <button class="btn btn-small btn-success" onclick="drawCard('${poolName}')">抽卡</button>
                    <button class="btn btn-small btn-danger" onclick="deletePool('${poolName}')">删除</button>
                </div>
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
    });
}

function renderPlayerHand() {
    const container = document.getElementById('playerHandArea');
    
    if (playerHand.length === 0) {
        container.className = 'empty';
        container.innerHTML = '<span class="empty-hint">暂无卡牌，请从卡池抽卡</span>';
        return;
    }
    
    container.className = '';
    container.innerHTML = playerHand.map(card => `
        <div class="card">
            <div class="card-front" onclick="enlargeCard('${card.image}', '${card.name}')">
                <img src="${card.image}" alt="${card.name}">
            </div>
            <div class="card-name">${card.name}</div>
            <div class="card-actions">
                <button class="card-action" style="background:#27ae60" onclick="useCard('${card.id}')" title="使用">用</button>
                <button class="card-action" style="background:#3498db" onclick="giftCard('${card.id}')" title="赠送">赠</button>
                <button class="card-action discard" onclick="discardCard('${card.id}')" title="弃牌">×</button>
            </div>
        </div>
    `).join('');
}

function renderTable() {
    const container = document.getElementById('tableArea');
    
    if (tableCards.length === 0) {
        container.innerHTML = '<span class="empty-hint">桌面为空，使用卡牌将显示在此</span>';
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
    return 'card_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}
