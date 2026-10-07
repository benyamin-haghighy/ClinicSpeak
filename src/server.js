const server = require('./app')
const sequelize = require('./config/db')
require('dotenv').config()
const startServer = ()=>{
    try {
        sequelize.authenticate()
            .then(()=>{
            console.log('connect to db is ok');
            })
            .catch(()=>{
                console.log('connect to db is not ok');
            })
        server.listen(process.env.PORT, ()=>{
            console.log('server is running');

        })
    } catch (error) {
        process.close()
    }

}

startServer()