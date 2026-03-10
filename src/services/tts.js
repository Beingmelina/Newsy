async function textToSpeech(text, voice = 'Craig') {
  console.log('TTS request - voice:', voice);
  const apiKey = process.env.INWORLD_API_KEY;
  if (!apiKey) {
    throw new Error('INWORLD_API_KEY environment variable not set');
  }
  const inworldVoice = (voice === 'nova') ? 'Ashley' : 'Craig';
  const response = await fetch('https://api.inworld.ai/tts/v1alpha/text:synthesize', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text: text,
      voice_id: inworldVoice,
      model_id: 'inworld-tts-1.5-mini',
      audio_config: {
        audio_encoding: 'MP3'
      }
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    console.error('Inworld TTS error:', response.status, errText);
    throw new Error('Inworld TTS failed: ' + errText);
  }
  const data = await response.json();
  if (!data.audioContent) {
    throw new Error('Inworld TTS returned no audio content');
  }
  const buffer = Buffer.from(data.audioContent, 'base64');
  console.log('TTS success - audio bytes:', buffer.length, 'voice:', inworldVoice);
  return buffer;
}
module.exports = { textToSpeech };
