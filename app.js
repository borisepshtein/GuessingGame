const state = {
    username: '',
    category: '',
    continents: [],
    periods: [],
    gameId: null,
    hint: '',
    questionCount: 0,
    conversationHistory: [],
    playedCharacters: [],
};

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

function setLoading(on, text = 'Thinking...') {
    document.getElementById('loading-text').textContent = text;
    document.getElementById('loading').classList.toggle('hidden', !on);
}

function updateCounter() {
    document.getElementById('question-counter').textContent =
        `Questions asked: ${state.questionCount}`;
}

function appendChatBubble(role, text) {
    const log = document.getElementById('chat-log');
    const div = document.createElement('div');
    div.className = role === 'user' ? 'chat-q' : 'chat-a';
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function getPlayedKey() {
    return `wai_played_${state.username}`;
}

function loadPlayedCharacters() {
    try { return JSON.parse(localStorage.getItem(getPlayedKey()) || '[]'); }
    catch { return []; }
}

function addToPlayedList(name) {
    const list = loadPlayedCharacters();
    if (!list.includes(name)) list.push(name);
    localStorage.setItem(getPlayedKey(), JSON.stringify(list));
}

function resetSetupScreen() {
    state.category = '';
    state.continents = [];
    state.periods = [];
    document.querySelectorAll('#category-grid .choice-btn').forEach(b => b.classList.remove('selected'));
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('selected'));
    document.getElementById('filter-panels').classList.add('hidden');
}

function goToSetup() {
    resetSetupScreen();
    showScreen('screen-setup');
}

// --- Welcome screen ---

function onPlayClick() {
    const name = document.getElementById('input-username').value.trim();
    if (!name) { document.getElementById('input-username').focus(); return; }
    state.username = name;
    localStorage.setItem('wai_username', name);
    resetSetupScreen();
    showScreen('screen-setup');
}

// --- Setup screen ---

function onCategoryClick(btn) {
    document.querySelectorAll('#category-grid .choice-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    state.category = btn.dataset.cat;
    state.continents = [];
    state.periods = [];
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('selected'));
    const needsFilters = state.category === 'historical' || state.category === 'both';
    document.getElementById('filter-panels').classList.toggle('hidden', !needsFilters);
}

function toggleFilter(btn, arrayKey) {
    btn.classList.toggle('selected');
    const val = btn.dataset.val;
    const arr = state[arrayKey];
    const idx = arr.indexOf(val);
    if (idx === -1) arr.push(val);
    else arr.splice(idx, 1);
}

async function onStartGameClick() {
    if (!state.category) {
        alert('Please select who I should think of.');
        return;
    }
    state.playedCharacters = loadPlayedCharacters();
    setLoading(true, 'Finding a character...');
    try {
        const res = await fetch('api/start-game', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: state.username,
                category: state.category,
                continents: state.continents,
                periods: state.periods,
                playedCharacters: state.playedCharacters,
            })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        state.gameId = data.gameId;
        state.hint = data.hint;
        state.questionCount = 0;
        state.conversationHistory = [];

        initGameScreen();
        showScreen('screen-game');
    } catch (err) {
        console.error(err);
        alert('Failed to start game. Please try again.');
    } finally {
        setLoading(false);
    }
}

// --- Game screen ---

function initGameScreen() {
    const catLabel = {
        historical: 'Historical Figure',
        literary: 'Literary Character',
        both: 'Historical Figure or Literary Character',
    }[state.category] || 'Character';

    document.getElementById('game-hint').textContent =
        `I am a ${catLabel} — ${state.hint}`;
    updateCounter();
    document.getElementById('chat-log').innerHTML = '';
    document.getElementById('input-question').value = '';
}

function openGuessScreen() {
    document.getElementById('input-guess').value = '';
    const fb = document.getElementById('guess-feedback');
    fb.textContent = '';
    fb.classList.add('hidden');
    showScreen('screen-guess');
}

async function askQuestion() {
    const input = document.getElementById('input-question');
    const question = input.value.trim();
    if (!question) { input.focus(); return; }

    input.value = '';
    const askBtn = document.getElementById('btn-ask');
    askBtn.disabled = true;

    appendChatBubble('user', question);
    state.questionCount++;
    updateCounter();

    setLoading(true, 'Thinking...');
    try {
        const res = await fetch('api/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                gameId: state.gameId,
                question,
                conversationHistory: state.conversationHistory,
            })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const answer = data.answer || 'I could not hear that. Please try again.';

        state.conversationHistory.push({ role: 'user', content: question });
        state.conversationHistory.push({ role: 'assistant', content: answer });

        appendChatBubble('assistant', answer);
    } catch (err) {
        console.error(err);
        appendChatBubble('assistant', 'Something went wrong. Please try again.');
    } finally {
        setLoading(false);
        askBtn.disabled = false;
        input.focus();
    }
}

async function onGiveUpClick() {
    if (!confirm('Are you sure you want to give up? The answer will be revealed.')) return;
    setLoading(true, 'Revealing...');
    try {
        const res = await fetch('api/give-up', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gameId: state.gameId })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        addToPlayedList(data.character);
        showResult(false, data.character);
    } catch (err) {
        console.error(err);
        alert('Could not reveal character. Please try again.');
    } finally {
        setLoading(false);
    }
}

// --- Guess screen ---

async function submitGuess() {
    const input = document.getElementById('input-guess');
    const guess = input.value.trim();
    if (!guess) { input.focus(); return; }

    const submitBtn = document.getElementById('btn-submit-guess');
    submitBtn.disabled = true;
    setLoading(true, 'Checking...');

    const fb = document.getElementById('guess-feedback');

    try {
        const res = await fetch('api/guess', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gameId: state.gameId, guess })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (data.correct) {
            addToPlayedList(data.character);
            showResult(true, data.character);
        } else {
            fb.textContent = data.message || 'Not quite — keep trying!';
            fb.classList.remove('hidden');
        }
    } catch (err) {
        console.error(err);
        fb.textContent = 'Could not check guess. Please try again.';
        fb.classList.remove('hidden');
    } finally {
        setLoading(false);
        submitBtn.disabled = false;
    }
}

// --- Result screen ---

function showResult(won, character) {
    const box = document.getElementById('result-box');
    box.classList.remove('win', 'lose');
    box.classList.add(won ? 'win' : 'lose');

    document.getElementById('result-icon').textContent = won ? 'CORRECT!' : 'GAME OVER';
    document.getElementById('result-message').textContent = won
        ? `It was ${character}. You asked ${state.questionCount} question${state.questionCount !== 1 ? 's' : ''}.`
        : `It was ${character}. Better luck next time!`;

    showScreen('screen-result');
}

// --- Leaderboard ---

async function loadLeaderboard() {
    setLoading(true, 'Loading leaderboard...');
    try {
        const res = await fetch('api/leaderboard');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        const tbody = document.getElementById('leaderboard-body');
        tbody.innerHTML = '';

        if (!data.leaderboard || data.leaderboard.length === 0) {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = 4;
            td.className = 'lb-empty';
            td.textContent = 'No wins yet — be the first!';
            tr.appendChild(td);
            tbody.appendChild(tr);
        } else {
            data.leaderboard.forEach((player, idx) => {
                const tr = document.createElement('tr');
                tr.innerHTML = `<td>${idx + 1}</td><td>${escapeHtml(player.name)}</td><td>${player.bestGame}</td><td>${player.wins}</td>`;
                tbody.appendChild(tr);
            });
        }
        showScreen('screen-leaderboard');
    } catch (err) {
        console.error(err);
        alert('Could not load leaderboard. Please try again.');
    } finally {
        setLoading(false);
    }
}

// --- Init ---

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('input-username').value = localStorage.getItem('wai_username') || '';

    // Welcome
    document.getElementById('btn-play').onclick = onPlayClick;
    document.getElementById('input-username').onkeydown = e => { if (e.key === 'Enter') onPlayClick(); };
    document.getElementById('btn-view-leaderboard').onclick = loadLeaderboard;

    // Setup
    document.querySelectorAll('#category-grid .choice-btn').forEach(btn => {
        btn.onclick = () => onCategoryClick(btn);
    });
    document.querySelectorAll('#continent-grid .filter-btn').forEach(btn => {
        btn.onclick = () => toggleFilter(btn, 'continents');
    });
    document.querySelectorAll('#period-grid .filter-btn').forEach(btn => {
        btn.onclick = () => toggleFilter(btn, 'periods');
    });
    document.getElementById('btn-start-game').onclick = onStartGameClick;
    document.getElementById('btn-setup-back').onclick = () => showScreen('screen-welcome');

    // Game
    document.getElementById('btn-ask').onclick = askQuestion;
    document.getElementById('input-question').onkeydown = e => { if (e.key === 'Enter') askQuestion(); };
    document.getElementById('btn-make-guess').onclick = openGuessScreen;
    document.getElementById('btn-give-up').onclick = onGiveUpClick;

    // Guess
    document.getElementById('btn-submit-guess').onclick = submitGuess;
    document.getElementById('input-guess').onkeydown = e => { if (e.key === 'Enter') submitGuess(); };
    document.getElementById('btn-cancel-guess').onclick = () => showScreen('screen-game');

    // Result
    document.getElementById('btn-play-again').onclick = goToSetup;
    document.getElementById('btn-go-leaderboard').onclick = loadLeaderboard;

    // Leaderboard
    document.getElementById('btn-lb-back').onclick = () => {
        if (state.username) goToSetup();
        else showScreen('screen-welcome');
    };

    showScreen('screen-welcome');
});
