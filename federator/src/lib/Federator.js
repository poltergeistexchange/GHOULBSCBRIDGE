const web3 = require('web3');
const fs = require('fs');
const abiBridge = require('../../../abis/Bridge.json');
const abiFederation = require('../../../abis/Federation.json');
const TransactionSender = require('./TransactionSender');
const CustomError = require('./CustomError');
const utils = require('./utils');

module.exports = class Federator {
    constructor(config, logger, Web3 = web3) {
        this.config = config;
        this.logger = logger;

        this.mainWeb3 = new Web3(config.mainchain.host);
        this.sideWeb3 = new Web3(config.sidechain.host);

        this.mainBridgeContract = new this.mainWeb3.eth.Contract(abiBridge, this.config.mainchain.bridge);
        this.sideBridgeContract = new this.sideWeb3.eth.Contract(abiBridge, this.config.sidechain.bridge);
        this.federationContract = new this.sideWeb3.eth.Contract(abiFederation, this.config.sidechain.federation);

        this.transactionSender = new TransactionSender(this.sideWeb3, this.logger, this.config);

        this.lastBlockPath = `${config.storagePath || __dirname}/lastBlock.txt`;
    }

    async run() {
        let retries = 3;
        const sleepAfterRetrie = 3000;
        while(retries > 0) {
            try {
                const currentBlock = await this.mainWeb3.eth.getBlockNumber();
                const chainId = await this.mainWeb3.eth.net.getId();
                let confirmations = 0; //for BSc regtest and ganache
                if(chainId == 97 || chainId == 42) { // Bsc testnet and kovan
                    confirmations = 10
                }
                if( chainId == 1) { //ethereum mainnet 24hs
                    confirmations = 5760
                }
                if(chainId == 56) { // Bsc mainnet 24hs
                    confirmations = 2880
                }
                const toBlock = currentBlock - confirmations;
                this.logger.info('Running to Block', toBlock);

                if (toBlock <= 0) {
                    return false;
                }

                if (!fs.existsSync(this.config.storagePath)) {
                    fs.mkdirSync(this.config.storagePath);
                }
                let originalFromBlock = this.config.mainchain.fromBlock || 0;
                let fromBlock = null;
                try {
                    fromBlock = fs.readFileSync(this.lastBlockPath, 'utf8');
                } catch(err) {
                    fromBlock = originalFromBlock;
                }
                if(fromBlock < originalFromBlock) {
                    fromBlock = originalFromBlock;
                }
                if(fromBlock >= toBlock){
                    this.logger.warn(`Current chain Height ${toBlock} is the same or lesser than the last block processed ${fromBlock}`);
                    return false;
                }
                fromBlock = parseInt(fromBlock)+1;
                this.logger.debug('Running from Block', fromBlock);
                
                const recordsPerPage = 1000;
                const numberOfPages = Math.ceil((toBlock - fromBlock) / recordsPerPage);
                this.logger.debug(`Total pages ${numberOfPages}, blocks per page ${recordsPerPage}`);

                var fromPageBlock = fromBlock;
                for(var currentPage = 1; currentPage <= numberOfPages; currentPage++) { 
                    var toPagedBlock = fromPageBlock + recordsPerPage-1;
                    if(currentPage == numberOfPages) {
                        toPagedBlock = toBlock
                    }
                    this.logger.debug(`Page ${currentPage} getting events from block ${fromPageBlock} to ${toPagedBlock}`);
                    const logs = await this.mainBridgeContract.getPastEvents('Cross', {
                        fromBlock: fromPageBlock,
                        toBlock: toPagedBlock
                    });
                    if (!logs) throw new Error('Failed to obtain the logs');

                    this.logger.info(`Found ${logs.length} logs`);
                    await this._processLogs(logs, toPagedBlock);
                    fromPageBlock = toPagedBlock + 1;
                }
                
                return true;
            } catch (err) {
                console.log(err)
                this.logger.error(new Error('Exception Running Federator'), err);
                retries--;
                this.logger.debug(`Run ${3-retries} retrie`);
                if( retries > 0) {
                    await utils.sleep(sleepAfterRetrie);
                } else {
                    process.exit();
                }
            }
        }
    }

    async _processLogs(logs, toBlock) {
        try {
            const transactionSender = new TransactionSender(this.sideWeb3, this.logger, this.config);
            const from = await transactionSender.getAddress(this.config.privateKey);
            
            for(let log of logs) {
                this.logger.info('Processing event log:', log);

                const { _to: receiver, _amount: amount, _symbol: symbol, _tokenAddress: tokenAddress,
                    _decimals: decimals, _granularity:granularity } = log.returnValues;

                let transactionId = await this.federationContract.methods.getTransactionId(
                    tokenAddress,
                    receiver,
                    amount,
                    symbol,
                    log.blockHash,
                    log.transactionHash,
                    log.logIndex,
                    decimals,
                    granularity
                ).call();
                this.logger.info('get transaction id:', transactionId);

                let wasProcessed = await this.federationContract.methods.transactionWasProcessed(transactionId).call();
                if (!wasProcessed) {
                    let hasVoted = await this.federationContract.methods.hasVoted(transactionId).call({from: from});
                    if(!hasVoted) {
                        this.logger.info(`Voting tx: ${log.transactionHash} block: ${log.blockHash} token: ${symbol}`);
                        await this._voteTransaction(tokenAddress,
                            receiver,
                            amount,
                            symbol,
                            log.blockHash,
                            log.transactionHash,
                            log.logIndex,
                            decimals,
                            granularity);
                    } else {
                        this.logger.debug(`Block: ${log.blockHash} Tx: ${log.transactionHash} token: ${symbol}  has already been voted by us`);
                    }
                    
                } else {
                    this.logger.debug(`Block: ${log.blockHash} Tx: ${log.transactionHash} token: ${symbol} was already processed`);
                }
            }
            this._saveProgress(this.lastBlockPath, toBlock);

            return true;
        } catch (err) {
            throw new CustomError(`Exception processing logs`, err);
        }
    }


    async _voteTransaction(tokenAddress, receiver, amount, symbol, blockHash, transactionHash, logIndex, decimals, granularity) {
        try {

            const transactionSender = new TransactionSender(this.sideWeb3, this.logger, this.config);
            this.logger.info(`Voting Transfer ${amount} of ${symbol} trough sidechain bridge ${this.sideBridgeContract.options.address} to receiver ${receiver}`);
            
            let txId = await this.federationContract.methods.getTransactionId(
                tokenAddress,
                receiver,
                amount,
                symbol,
                blockHash,
                transactionHash,
                logIndex,
                decimals,
                granularity
            ).call();
            
            let txData = await this.federationContract.methods.voteTransaction(
                tokenAddress,
                receiver,
                amount,
                symbol,
                blockHash,
                transactionHash,
                logIndex,
                decimals,
                granularity
            ).encodeABI();

            this.logger.info(`voteTransaction(${tokenAddress}, ${receiver}, ${amount}, ${symbol}, ${blockHash}, ${transactionHash}, ${logIndex}, ${decimals}, ${granularity})`);
            await transactionSender.sendTransaction(this.federationContract.options.address, txData, 0, this.config.privateKey);
            this.logger.info(`Voted transaction:${transactionHash} of block: ${blockHash} token ${symbol} to Federation Contract with TransactionId:${txId}`);
            return true;
        } catch (err) {
            throw new CustomError(`Exception Voting tx:${transactionHash} block: ${blockHash} token ${symbol}`, err);
        }
    }

    _saveProgress (path, value) {
        if (value) {
            fs.writeFileSync(path, value.toString());
        }
    }
}
