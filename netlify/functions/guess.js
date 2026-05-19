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

    const { gameId, guess } = body;

    if (!gameId || !guess) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    try {
        // Fetch game record to get character name
        const atGetRes = await fetch(
            `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}/${gameId}`,
            { headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}` } }
        );

        if (!atGetRes.ok) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Game not found' }) };
        }

        const record = await atGetRes.json();
        const character = record.fields?.Character;

        if (!character) {
            return { statusCode: 500, body: JSON.stringify({ error: 'Game data corrupted' }) };
        }

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
            return { statusCode: 500, body: JSON.stringify({ error: 'AI service error' }) };
        }

        const claudeData = await claudeRes.json();
        const rawText = claudeData.content?.[0]?.text ?? '';

        let parsed;
        try {
            parsed = extractJSON(rawText);
        } catch (err) {
            console.error('Failed to parse Claude JSON:', rawText, err);
            return { statusCode: 500, body: JSON.stringify({ error: 'Failed to validate guess' }) };
        }

        const { correct, message } = parsed;

        if (correct) {
            // Update Airtable: mark as won and store the player's guess
            await fetch(
                `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}/${gameId}`,
                {
                    method: 'PATCH',
                    headers: {
                        'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ fields: { Status: 'won', PlayerGuess: guess } })
                }
            );
            // Reveal character name only on a confirmed correct guess
            return { statusCode: 200, body: JSON.stringify({ correct: true, message, character }) };
        }

        // Wrong guess — do not reveal character name
        return { statusCode: 200, body: JSON.stringify({ correct: false, message }) };

    } catch (err) {
        console.error('Server error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
    }
};

function extractJSON(text) {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    return JSON.parse((match ? match[1] : text).trim());
}
