const { askSystemPrompt } = require('./prompts.json');

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

    const { gameId, question, conversationHistory = [] } = body;

    if (!gameId || !question) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    try {
        // Fetch game record to get character name (never exposed to client mid-game)
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
        const currentCount = record.fields?.QuestionCount || 0;
        const questionNumber = currentCount + 1;

        if (!character) {
            return { statusCode: 500, body: JSON.stringify({ error: 'Game data corrupted' }) };
        }

        const systemPrompt = askSystemPrompt
            .replace('{character}', character)
            .replace('{questionNumber}', questionNumber);

        // Limit history to last 20 exchanges to stay within token limits
        const messages = [
            ...conversationHistory.slice(-20),
            { role: 'user', content: question }
        ];

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
            return { statusCode: 500, body: JSON.stringify({ error: 'AI service error' }) };
        }

        const claudeData = await claudeRes.json();
        const answer = claudeData.content?.[0]?.text ?? 'I could not hear that. Please try again.';

        // Build full conversation log for Airtable (human-readable)
        const updatedConversation = [
            ...conversationHistory,
            { role: 'user', content: question },
            { role: 'assistant', content: answer },
        ];
        const conversationLog = updatedConversation
            .reduce((lines, msg, i, arr) => {
                if (msg.role === 'user') {
                    const qNum = Math.floor(i / 2) + 1;
                    lines.push(`Q${qNum}: ${msg.content}`);
                } else {
                    lines.push(`A: ${msg.content}\n`);
                }
                return lines;
            }, [])
            .join('\n');

        // Update Airtable: increment QuestionCount and append conversation log
        await fetch(
            `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}/${gameId}`,
            {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ fields: { QuestionCount: questionNumber, Conversation: conversationLog } })
            }
        );

        return { statusCode: 200, body: JSON.stringify({ answer }) };

    } catch (err) {
        console.error('Server error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Server error' }) };
    }
};
