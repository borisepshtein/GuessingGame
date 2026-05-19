require('dotenv').config();
const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

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

const insertGame    = db.prepare(`INSERT INTO games (username, character, category, filters, status, question_count, player_guess, timestamp) VALUES (@username, @character, @category, @filters, 'in-progress', 0, '', @timestamp)`);
const getGame       = db.prepare(`SELECT * FROM games WHERE id = ?`);
const updateCount   = db.prepare(`UPDATE games SET question_count = @count, conversation = @conversation WHERE id = @id`);
const updateStatus  = db.prepare(`UPDATE games SET status = @status, player_guess = @guess WHERE id = @id`);
const setGaveUp     = db.prepare(`UPDATE games SET status = 'gave-up' WHERE id = ?`);

// POST /api/start-game
app.post('/api/start-game', async (req, res) => {
    const { username, category, continents = [], periods = [], playedCharacters = [] } = req.body;

    if (!username || !category) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    let categoryInstruction;
    if (category === 'historical') {
        categoryInstruction = 'Think of a real historical figure (not a fictional character).';
    } else if (category === 'literary') {
        categoryInstruction = 'Think of a well-known fictional literary character from a novel, play, or poem (not a real person).';
    } else {
        categoryInstruction = 'Think of either a real historical figure OR a well-known fictional literary character — your choice.';
    }

    let filterLines = '';
    if (category !== 'literary') {
        if (continents.length > 0) filterLines += `\n- The historical figure must be from one of these regions: ${continents.join(', ')}.`;
        if (periods.length > 0)    filterLines += `\n- The historical figure must have lived primarily during: ${periods.join(', ')}.`;
    }

    const playedList = playedCharacters.length > 0 ? playedCharacters.join(', ') : 'none';

    const systemPrompt = `You are the game master for a "Who Am I?" guessing game.
Pick ONE character for the player to guess. Rules:
- ${categoryInstruction}${filterLines}
- Do NOT pick any of these already-played characters: ${playedList}
- Pick someone a reasonably educated adult would recognize.
Respond ONLY with valid JSON, no markdown fences, no commentary:
{"character": "Full Name", "hint": "Short descriptive label, e.g. 'Ancient Greek philosopher' or 'protagonist of a Victorian novel'"}
The hint must NOT contain the character's name and must not immediately give the answer away.`;

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
        const rawText = claudeData.content?.[0]?.text ?? '';
        const parsed = extractJSON(rawText);
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

    const character = record.character;
    const questionNumber = record.question_count + 1;

    const { askSystemPrompt } = require('./netlify/functions/prompts.json');
    const systemPrompt = askSystemPrompt
        .replace('{character}', character)
        .replace('{questionNumber}', questionNumber);

    const messages = [
        ...conversationHistory.slice(-20),
        { role: 'user', content: question }
    ];

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

    const character = record.character;

    const systemPrompt = `You are validating a guess in a "Who Am I?" guessing game.
The correct answer is: ${character}
The player guessed: ${guess}

Rules for accepting a guess as correct:
- Accept the full name or the most commonly used name (e.g., "Einstein" for "Albert Einstein").
- Accept common alternate names, pen names, stage names, or historical name variants.
- Accept reasonable spelling variations and transliterations.
- Reject if the guess refers to a clearly different person or character.

Respond ONLY with valid JSON, no markdown fences, no commentary:
{"correct": true, "message": "Yes! You got it!"} or {"correct": false, "message": "Not quite — keep trying!"}`;

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
            return res.json({ correct: true, message, character });
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
