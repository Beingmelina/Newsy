const VOICE_MAP = {
  'male-american': 'nPczCjzI2devNBz1zQrb',
  'male-british': 'Z7rMwyCsIFBOJYGA90x5',
  'female-american': 'GyAmfuVW0xquOSDB3g94',
  'female-british': 'khYwAWwYSjlxlcrwGQ16',
  'ash': 'nPczCjzI2devNBz1zQrb',
  'coral': 'GyAmfuVW0xquOSDB3g94',
};

async function textToSpeech(text, voice = 'ash', accent = 'american') {
  console.log('TTS request - text length:', text.length, 'voice:', voice, 'accent:', accent);

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error('ELEVENLABS_API_KEY environment variable not set');
  }

  const gender = (voice === 'coral') ? 'female' : 'male';
  const voiceKey = `${gender}-${accent}`;
  const voiceId = VOICE_MAP[voiceKey] || VOICE_MAP[voice] || VOICE_MAP['ash'];

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text: text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.65,
          similarity_boost: 0.8,
          style: 0.2,
          use_speaker_boost: true
        }
      })
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    console.error('ElevenLabs TTS error:', response.status, errText);
    throw new Error('ElevenLabs TTS failed: ' + errText);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  console.log('TTS success - audio bytes:', buffer.length);
  return buffer;
}

module.exports = { textToSpeech };
