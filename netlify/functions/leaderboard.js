exports.handler = async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        const formula = encodeURIComponent(`{Status}='won'`);
        const fields = 'fields%5B%5D=Username&fields%5B%5D=QuestionCount';
        const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}?filterByFormula=${formula}&${fields}`;

        const atRes = await fetch(url, {
            headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}` }
        });

        if (!atRes.ok) {
            console.error('Airtable error:', await atRes.text());
            return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch leaderboard' }) };
        }

        const atData = await atRes.json();
        const records = atData.records || [];

        // Aggregate per player: count wins and track best (lowest) question count
        const players = {};
        for (const record of records) {
            const username = record.fields?.Username || 'Unknown';
            const questionCount = record.fields?.QuestionCount || 0;
            if (!players[username]) {
                players[username] = { wins: 0, bestGame: Infinity };
            }
            players[username].wins++;
            if (questionCount < players[username].bestGame) {
                players[username].bestGame = questionCount;
            }
        }

        const leaderboard = Object.entries(players)
            .map(([name, d]) => ({
                name,
                wins: d.wins,
                bestGame: d.bestGame === Infinity ? 0 : d.bestGame,
            }))
            .sort((a, b) => a.bestGame - b.bestGame || b.wins - a.wins)
            .slice(0, 20);

        return { statusCode: 200, body: JSON.stringify({ leaderboard }) };

    } catch (err) {
        console.error('Server error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
    }
};
