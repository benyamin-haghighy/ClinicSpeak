const express = require('express')
const app = express()
require('dotenv').config()
const fs = require('fs')
const askAi = require('./service/ask_ai/ask.ai.services')
const tts = require('./service/tts/tts.services')
const calculateTurnScore = require('./validation/validation_listening/calculateTurnScore')
const createIotypeConnection = require('./service/ws/createIotypeConnection')
const createConversation = require('./utils/createConversation')
const createMessage = require('./utils/createMessage')
const createEmbeddingMessage = require('./service/embedding/embedding.services')
const searchVector = require('./utils/searchVector')
const getAllmessages = require('./utils/getAllMessages')
const createSession = require('./utils/createSession')
const createWsConnection = require('./service/ws/createWsServer')
const createAudio = require('./utils/createAudio')
const path = require('path')



const STATUS = { CONNECTING: 'connecting', LISTENING: 'listening', ANSWERING: 'answering' , CLOSE:"close"}

app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'views'))


app.use(express.json())
app.use(express.urlencoded({extended:true}))
app.use('/public',express.static(path.join(__dirname, 'public')))
app.use('/js',express.static(path.join(__dirname, 'public', 'js')))
app.use('/css',express.static(path.join(__dirname, 'public', 'css')))



app.get('/',(req,res)=>{
    res.render('home')
})
app.get('/login', (req,res)=>{
    console.log('salam');
    
    res.render('login')
})
app.post('/login', (req,res)=>{
    res.redirect('/')
})
const handleCall = async (wsConnection,req) => {
    const phone = new URL(req.url, 'http://localhost:8080').searchParams.get('phone')
    if (!/^09\d{9}$/.test(phone || '')) {
        wsConnection.close(1008, 'invalid phone')
        return
    }
    await createAudio(phone) 
    const session = await createSession(phone)
    const state = {turnText:'', turnCompletionTimer:null, status:STATUS.CONNECTING,stt:null}
    wsConnection.on('message', async(data,isBinary)=>{
                    if (isBinary && state.status === STATUS.LISTENING) {
                        state.stt.send(data)
                    }else if (!isBinary) {
                        data = JSON.parse(data.toString())
                        if (data.text ==='stop') {
                            state.stt?.close()
                            state.stt = null
                            state.status = STATUS.CLOSE
                            clearTimeout(state.turnCompletionTimer)
                        }
                        if (data.text === 'audio_finished' && state.status === STATUS.ANSWERING) {
                            console.log('پایان پخش صدا...')
                            state.turnText = ''
                            await startTurn(
                                phone,
                                session.id,
                                wsConnection,
                                state
                            )
                        }
                    }

                })
    wsConnection.on('close', () => {
        state.stt?.close()
        state.stt = null
        state.status = STATUS.CLOSE
        clearTimeout(state.turnCompletionTimer)
    })
    wsConnection.on('error', (error) => {
        console.error('WebSocket error:', error)
    })
    await startTurn(phone, session.id,wsConnection, state)

}

const startTurn  = async(phone, session_id,wsConnection,state) => {
    if (state.status === STATUS.CLOSE) {
        return
    }
    console.log('========== START TURN ==========')    
    state.status = STATUS.CONNECTING
    await createConversation(phone)
    if (state.status === STATUS.CLOSE) return
    const ws = createIotypeConnection()
    state.stt = ws
    ws.on('message', async (data) => {
            if (state.status === STATUS.CLOSE) {
                return
            }
             if(state.stt!==ws)return 

            data = JSON.parse(data.toString())
            if (data.status==="authorized") {
                state.status= STATUS.LISTENING
                
            }
            if (data.partial) {
                console.log('partial ->', data.partial);
                
            }
            if (data.text) {

                 state.turnText += (state.turnText ? ' ' : '') + data.text.trim()
                console.log('🟢 CURRENT TURN TEXT:', state.turnText)
                if (state.turnCompletionTimer) {
                    clearTimeout(state.turnCompletionTimer)
                }
            
                state.turnCompletionTimer = setTimeout(async() => {
                    console.log('⏱️ 3 SECONDS PASSED')
                    console.log('📝 TEXT AFTER 3 SECONDS:', state.turnText)

                    const score = calculateTurnScore(
                        state.turnText
                    )

                    console.log('🎯 TURN SCORE:', score)

                    if (score >= 2) {
                        wsConnection.send(JSON.stringify({ type: 'status', status: 'answering' }))
                        state.status = STATUS.ANSWERING
                        finishTurn(state.stt)
                        state.stt =null
                        const messages = await createMessage('user', state.turnText,phone, session_id)
                        const embeddingMessageUser = await createEmbeddingMessage(messages[0].content)
                        let documnets = await searchVector(embeddingMessageUser)
                        const numberCompareSimilarity = 5/10
                         if (messages[1]) {
                            const newEmbeddingMessageUser = await createEmbeddingMessage(
                        `${messages[1].content}\n${messages[0].content}`
                        )
                             const new_documnets = await searchVector(
                             newEmbeddingMessageUser
                             )
                             if (documnets[0].Similarity >= new_documnets[0].Similarity-0.05) {
                                 documnets = documnets.slice(0, 2)
                             }else{
                                 documnets = new_documnets.slice(0, 2)
                             }
                         }else{
                             documnets = documnets.slice(0,2)
                         }
                         const allMessages = await getAllmessages(phone)
                         const responseAi =(documnets[0].Similarity < numberCompareSimilarity) ?'اطلاعات کافی برای پاسخ به این سوال در اختیار ندارم.':await askAi({messages:allMessages.reverse(),documnets})
                        await createMessage('assistant', responseAi, phone, session_id)
                        await showVoiceToUser(responseAi, phone, wsConnection, state)
                    } else {
                        console.log('⏳ TURN IS NOT COMPLETE - KEEP LISTENING')
                        wsConnection.send(JSON.stringify({ type: 'status', status: 'listening' }))
                    }
                }, 3000)
         }
    })
    ws.on('error', (error) => {
        console.log('Iotype WebSocket error:', error.message)
    })

    ws.on('close', (code, reason) => {
        console.log(
            'Iotype closed:',
            code,
            reason.toString()
        )
    })

}
const finishTurn = (wsIoType) => {
        wsIoType.close()
}
const showVoiceToUser = async(responseAi, phone, wsConnection,state) => {
    if (state.status === STATUS.CLOSE) {
        return
    }
    await tts(responseAi,phone)

    console.log('شروع پخش صدا...')
    const audio_user = fs.readFileSync(path.join(__dirname, 'audio', 'user_audio', `${phone}.wav`))
    wsConnection.send(audio_user)
}
createWsConnection(handleCall)


module.exports = app