# GHOULBSCBRIDGE

 Ghoul Bridge allows the movement of token from Binance smart chain  to ethereum bridge and vice versa

## Installation

```
npm install
```

## Run tests

```
npm test
```

## Configuration

Create a `.env` file with keys

```
MNEMONIC="..."
INFURA_ID="..."
ETHERSCAN_API_KEY="..."
ETHERSCAN_API_KEY="..."
```

* Deployment to Kovan is done via [Infura](https://infura.io/).
* Create an [Etherscan API key](https://etherscan.io/myapikey) for contract verification.



## Deployment

### Ganache

[Ganache](https://www.trufflesuite.com/ganache) is a personal Ethereum blockchain for development and
tests.

```
truffle migrate -- --network development
```

### Kovan



```
truffle migrate -- --network Kovan
truffle run verify -- --network Kovan
```



