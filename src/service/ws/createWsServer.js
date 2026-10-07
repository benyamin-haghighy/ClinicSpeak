const webSoket = require('ws')

module.exports = (handleCall)=>{
    const ws = new webSoket.Server({ port: 8080 })
    ws.on('connection', (wsConnection,req) => {
        handleCall(wsConnection,req)
    })
}