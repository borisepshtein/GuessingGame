exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    let body;
    try {
        body = JSON.parse(event.body);
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const { gameId } = body;

    if (!gameId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing gameId' }) };
    }

    try {
        // Fetch game record to get character name
        const atGetRes = await fetch(
            `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}/${gameId}`,
            { headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}` } }
        );

        if (!atGetRes.ok) {
            console.error('Airtable GET error:', await atGetRes.text());
            return { statusCode: 404, body: JSON.stringify({ error: 'Game not found' }) };
        }

        const record = await atGetRes.json();
        const character = record.fields?.Character;

        // Mark game as gave-up
        await fetch(
            `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}/${gameId}`,
            {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ fields: { Status: 'gave-up' } })
            }
        );

        // Now safe to reveal the character
        return { statusCode: 200, body: JSON.stringify({ character }) };

    } catch (err) {
        console.error('Server error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
    }
};
