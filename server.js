require('dotenv').config();
const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const prompts = require('./netlify/functions/prompts.json');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const db = new Database(path.join(__dirname, 'games.db'));
db.exec(`
    CREATE TABLE IF NOT EXISTS games (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT,
        character     TEXT,
        category      TEXT,
        filters       TEXT,
        status        TEXT DEFAULT 'in-progress',
        question_count INTEGER DEFAULT 0,
        player_guess  TEXT DEFAULT '',
        timestamp     TEXT,
        conversation  TEXT DEFAULT ''
    )
`);

const insertGame   = db.prepare(`INSERT INTO games (username, character, category, filters, status, question_count, player_guess, timestamp) VALUES (@username, @character, @category, @filters, 'in-progress', 0, '', @timestamp)`);
const getGame      = db.prepare(`SELECT * FROM games WHERE id = ?`);
const updateCount  = db.prepare(`UPDATE games SET question_count = @count, conversation = @conversation WHERE id = @id`);
const updateStatus = db.prepare(`UPDATE games SET status = @status, player_guess = @guess WHERE id = @id`);
const setGaveUp    = db.prepare(`UPDATE games SET status = 'gave-up' WHERE id = ?`);

const getPlayedCharacters = db.prepare(`SELECT character FROM games WHERE username = ? AND character IS NOT NULL AND character != ''`);

// POST /api/start-game
app.post('/api/start-game', async (req, res) => {
    const { username, category, continents = [], periods = [] } = req.body;

    if (!username || !category) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const played = getPlayedCharacters.all(username).map(r => r.character);

    const { template, categoryInstructions, filterTemplates } = prompts.startGameSystemPrompt;
    const categoryInstruction = categoryInstructions[category] ?? categoryInstructions.any;

    let filterLines = '';
    if (category !== 'literary') {
        if (continents.length > 0) filterLines += `\n- ${filterTemplates.continents.replace('{values}', continents.join(', '))}`;
        if (periods.length > 0)    filterLines += `\n- ${filterTemplates.periods.replace('{values}', periods.join(', '))}`;
    }

    const systemPrompt = template
        .replace('{categoryInstruction}', categoryInstruction)
        .replace('{filterLines}', filterLines)
        .replace('{playedList}', played.length > 0 ? played.join(', ') : 'none');

    try {
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-6',
                max_tokens: 256,
                system: systemPrompt,
                messages: [{ role: 'user', content: 'Choose a character now.' }]
            })
        });

        if (!claudeRes.ok) {
            console.error('Anthropic API error:', await claudeRes.text());
            return res.status(500).json({ error: 'AI service error' });
        }

        const claudeData = await claudeRes.json();
        const parsed = extractJSON(claudeData.content?.[0]?.text ?? '');
        const { character, hint } = parsed;

        if (!character || !hint) {
            return res.status(500).json({ error: 'Invalid character data from AI' });
        }

        const gameId = insertGame.run({
            username, character, category,
            filters: JSON.stringify({ continents, periods }),
            timestamp: new Date().toISOString().slice(0, 10),
        }).lastInsertRowid;

        res.json({ gameId, hint });
    } catch (err) {
        console.error('Server error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/ask
app.post('/api/ask', async (req, res) => {
    const { gameId, question, conversationHistory = [] } = req.body;

    if (!gameId || !question) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const record = getGame.get(gameId);
    if (!record) return res.status(404).json({ error: 'Game not found' });

    const questionNumber = record.question_count + 1;
    const systemPrompt = prompts.askSystemPrompt
        .replace('{character}', record.character)
        .replace('{questionNumber}', questionNumber);

    const messages = [...conversationHistory.slice(-20), { role: 'user', content: question }];

    try {
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-6',
                max_tokens: 256,
                system: systemPrompt,
                messages,
            })
        });

        if (!claudeRes.ok) {
            console.error('Anthropic API error:', await claudeRes.text());
            return res.status(500).json({ error: 'AI service error' });
        }

        const claudeData = await claudeRes.json();
        const answer = claudeData.content?.[0]?.text ?? 'I could not hear that. Please try again.';

        const updatedHistory = [...conversationHistory, { role: 'user', content: question }, { role: 'assistant', content: answer }];
        const conversationLog = updatedHistory.reduce((lines, msg, i) => {
            if (msg.role === 'user') lines.push(`Q${Math.floor(i / 2) + 1}: ${msg.content}`);
            else lines.push(`A: ${msg.content}\n`);
            return lines;
        }, []).join('\n');

        updateCount.run({ count: questionNumber, conversation: conversationLog, id: gameId });

        res.json({ answer });
    } catch (err) {
        console.error('Server error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/guess
app.post('/api/guess', async (req, res) => {
    const { gameId, guess } = req.body;

    if (!gameId || !guess) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const record = getGame.get(gameId);
    if (!record) return res.status(404).json({ error: 'Game not found' });

    const systemPrompt = prompts.guessSystemPrompt
        .replace('{character}', record.character)
        .replace('{guess}', guess);

    try {
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-6',
                max_tokens: 128,
                system: systemPrompt,
                messages: [{ role: 'user', content: `Is "${guess}" correct?` }]
            })
        });

        if (!claudeRes.ok) {
            console.error('Anthropic API error:', await claudeRes.text());
            return res.status(500).json({ error: 'AI service error' });
        }

        const claudeData = await claudeRes.json();
        const parsed = extractJSON(claudeData.content?.[0]?.text ?? '');
        const { correct, message } = parsed;

        if (correct) {
            updateStatus.run({ status: 'won', guess, id: gameId });
            return res.json({ correct: true, message, character: record.character });
        }

        res.json({ correct: false, message });
    } catch (err) {
        console.error('Server error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/give-up
app.post('/api/give-up', (req, res) => {
    const { gameId } = req.body;

    if (!gameId) return res.status(400).json({ error: 'Missing gameId' });

    const record = getGame.get(gameId);
    if (!record) return res.status(404).json({ error: 'Game not found' });

    setGaveUp.run(gameId);
    res.json({ character: record.character });
});

// GET /api/leaderboard
app.get('/api/leaderboard', (req, res) => {
    const records = db.prepare(`SELECT username, question_count FROM games WHERE status = 'won'`).all();

    const players = {};
    for (const r of records) {
        const name = r.username || 'Unknown';
        const q = r.question_count || 0;
        if (!players[name]) players[name] = { wins: 0, bestGame: Infinity };
        players[name].wins++;
        if (q < players[name].bestGame) players[name].bestGame = q;
    }

    const leaderboard = Object.entries(players)
        .map(([name, d]) => ({ name, wins: d.wins, bestGame: d.bestGame === Infinity ? 0 : d.bestGame }))
        .sort((a, b) => a.bestGame - b.bestGame || b.wins - a.wins)
        .slice(0, 20);

    res.json({ leaderboard });
});

function extractJSON(text) {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    return JSON.parse((match ? match[1] : text).trim());
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`GuessingGame running on port ${PORT}`));
