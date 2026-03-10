async function textToSpeech(text, voice = 'Craig') {
  console.log('TTS request - voice:', voice);
  console.log('TTS text preview (first 100 chars):', JSON.stringify(text.substring(0, 100)));
  const apiKey = process.env.INWORLD_API_KEY;
  if (!apiKey) {
    throw new Error('INWORLD_API_KEY environment variable not set');
  }
  const inworldVoice = (voice === 'nova') ? 'Ashley' : 'Craig';
  const cleanText = text
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_{1,2}(.+?)_{1,2}/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/[-\u2013\u2014]{3,}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const response = await fetch('https://api.inworld.ai/tts/v1alpha/text:synthesize', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text: cleanText,
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
