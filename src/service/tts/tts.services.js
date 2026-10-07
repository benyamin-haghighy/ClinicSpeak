const axios = require("axios");
const fs = require("fs");
const path = require('path')
require("dotenv").config();

const textToSpeech = async (text,phone) => {
    try {
        const response = await axios.post(
            "https://freetts.org/api/v1/tts",
            {
                text,
                voice: "fa-IR-DilaraNeural",
                rate: "+0%", 
                pitch: "+0Hz"
            },
            {
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key":process.env.FREE_TTS_API_KEY
                }
            }
        );
        const audioResponse = await axios.get(response.data.audio_url,{
            responseType:"arraybuffer"
        })
        fs.writeFileSync(path.join(__dirname,'../','../', 'audio','user_audio', `${phone}.wav`),audioResponse.data)
        console.log("Audio saved!");
    } catch (error) {
        console.error(
            "TTS Error:",
            error.response?.data || error.message
        );

        throw error;
    }
};

module.exports = textToSpeech;