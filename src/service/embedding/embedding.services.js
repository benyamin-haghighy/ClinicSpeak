const axios = require('axios')
require('dotenv').config()
console.log(process.env.OPENROUTER_API_KEY);

module.exports = async(content)=>{
    const response = await axios.post('https://openrouter.ai/api/v1/embeddings',{
        model:'liquid/lfm-2.5-embedding-350m:free',
        input:content
    },{
        headers:{
            Authorization:`Bearer ${process.env.OPENROUTER_API_KEY}`
        }
    })
    return response.data.data[0].embedding
}