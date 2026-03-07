const VOICE_MAP = {
  'male': 'onyx',
  'female': 'nova',
  // legacy mappings for backward compatibility
  'male-american': 'onyx',
  'male-british': 'onyx',
  'female-american': 'nova',
  'female-british': 'nova',
  'ash': 'onyx',
  'coral': 'nova',
};

async function textToSpeech(text, voice = 'ash', accent = 'american') {
  console.log('TTS request - text length:', text.length, 'voice:', voice, 'accent:', accent);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable not set');
  }

  const gender = (voice === 'coral' || voice === 'female' || voice?.startsWith('female')) ? 'female' : 'male';
  const openaiVoice = VOICE_MAP[voice] || VOICE_MAP[gender] || 'onyx';

  const response = await fetch(
    'https://api.openai.com/v1/audio/speech',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice: openaiVoice,
        response_format: 'mp3',
      })
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    console.error('OpenAI TTS error:', response.status, errText);
    throw new Error('OpenAI TTS failed: ' + errText);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  console.log('TTS success - audio bytes:', buffer.length, 'voice:', openaiVoice);
  return buffer;
}

module.exports = { textToSpeech };
