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

    const { username, category, continents = [], periods = [], playedCharacters = [] } = body;

    if (!username || !category) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
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
        if (continents.length > 0) {
            filterLines += `\n- The historical figure must be from one of these regions: ${continents.join(', ')}.`;
        }
        if (periods.length > 0) {
            filterLines += `\n- The historical figure must have lived primarily during: ${periods.join(', ')}.`;
        }
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
            return { statusCode: 500, body: JSON.stringify({ error: 'AI service error' }) };
        }

        const claudeData = await claudeRes.json();
        const rawText = claudeData.content?.[0]?.text ?? '';

        let parsed;
        try {
            parsed = extractJSON(rawText);
        } catch (err) {
            console.error('Failed to parse Claude JSON:', rawText, err);
            return { statusCode: 500, body: JSON.stringify({ error: 'Failed to pick a character. Please try again.' }) };
        }

        const { character, hint } = parsed;
        if (!character || !hint) {
            return { statusCode: 500, body: JSON.stringify({ error: 'Invalid character data from AI' }) };
        }

        // Create Airtable record — character name stored here, never returned to client
        const atRes = await fetch(
            `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    records: [{
                        fields: {
                            Username: username,
                            Character: character,
                            Category: category,
                            Filters: JSON.stringify({ continents, periods }),
                            Status: 'in-progress',
                            QuestionCount: 0,
                            PlayerGuess: '',
                            Timestamp: new Date().toISOString().slice(0, 10),
                        }
                    }]
                })
            }
        );

        if (!atRes.ok) {
            console.error('Airtable error:', await atRes.text());
            return { statusCode: 500, body: JSON.stringify({ error: 'Failed to save game record' }) };
        }

        const atData = await atRes.json();
        const gameId = atData.records?.[0]?.id;

        if (!gameId) {
            return { statusCode: 500, body: JSON.stringify({ error: 'Failed to get game ID' }) };
        }

        // Return only gameId + hint — character name is never sent to the client
        return { statusCode: 200, body: JSON.stringify({ gameId, hint }) };

    } catch (err) {
        console.error('Server error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
    }
};

function extractJSON(text) {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    return JSON.parse((match ? match[1] : text).trim());
}
