// ============== Covenant Parameters ====================
const DEBTID 			= "959632fd0e674a4158d17167b0963f586ec19ffcea204e030d1c1f6541c3348f"; // SLP token ID for the tokenised debt
const bchCollateralAddress 	= '...'; // address holding the BCH as collateral
const smartContractMnemonic 	= '...'; // mnemonic for the address holding the BCH collateral
const decodeTx 			= 'OP_RETURN 653 6a028d024039353936333266643065363734613431353864313731363762303936336635383665633139666663656132303465303330643163316636353431633333343866'; // the tx # where the token ID was stored onchain via memopress
var totalBCHCollateral 		= 1; // total BCH as collateral for the loan
const bchUSDThreashold 		= 63; // if BCH USD price falls below this then it constitutes a breach of debt covenant
const network 			= 'testnet';

// Initialise BITBOX based on chosen network
const { BITBOX } = require('bitbox-sdk');
if (network === 'mainnet')
	bitbox = new BITBOX({ restURL: 'https://rest.bitcoin.com/v2/' })
else bitbox = new BITBOX({ restURL: 'https://trest.bitcoin.com/v2/' });

// instantiate the SLP SDK based on the chosen network
const SLPSDK = require("../../slp-sdk/lib/SLP");
if (network === `mainnet`)
	SLP = new SLPSDK({ restURL: `https://rest.bitcoin.com/v2/` })
else SLP = new SLPSDK({ restURL: `https://trest.bitcoin.com/v2/` });

// Initialise CashScript contract based on the chosen network
const { Contract, Sig, FailedRequireError } = require('cashscript');
const path = require('path');
const rootSeed = bitbox.Mnemonic.toSeed(smartContractMnemonic);
const hdNode = bitbox.HDNode.fromSeed(rootSeed, network);
const collateralFundPkh = bitbox.Crypto.hash160(
	bitbox.ECPair.toPublicKey(
	bitbox.HDNode.toKeyPair(
	bitbox.HDNode.derive(hdNode, 0)
	)));
const P2PKH = Contract.compile(path.join(__dirname, 'Debt_Covenant.cash'), network); // Compile the Cash Contract
const instance = P2PKH.new(collateralFundPkh); // Instantiate a new P2PKH contract with constructor arguments: { pkh: collateralFundPkh }

/*
  Checks whether the Debt Covenant has been breached based on current price
 */
checkDebtCovenant();
async function checkDebtCovenant() {

	// initialise distribution variables
	var totalDividends = 100; // i.e. 100% of the debt tokenisation
	var distributionRate = 0;

	// retrieves and decodes the debt obligation token ID permanently stored onchain via blockpress
	let memopress = require('memopress');
	var memo = memopress.decode(decodeTx).message;
	const onchainTokenId = memo.split('@').pop(); // removes the '@' and opcode from buffer

	// Calls the CashScript contract to validate the Debt ID being used
	var debtIdValidation = await validateTokenId(DEBTID, onchainTokenId);
	
	// Calls Bitbox to validate whether the convenant is in breach based on BCH price
	var covenantBreachCheck = await validateBchPrice();
	
	// commence debt repayment ONLY if Debt ID matches AND BCH prices falls below threshold
	if (debtIdValidation == true && covenantBreachCheck == true) { 
		
		//retrieve address details for collateral cash address
		var balance = await SLP.Address.details(bchCollateralAddress);

		// retrieve array of debt obligation token holders
		var debtObHolders = await SLP.Utils.balancesForToken(DEBTID); 
		const debtObAddrCount = debtObHolders.length;

		// calculate distribution repayment to creditors
		distributionRate = totalBCHCollateral / totalDividends;  

		// passes the array of creditors and release collateral BCH as repayment
		releaseCollateral(debtObHolders, distributionRate, debtObAddrCount);

	} else { // if the token ID did not match the onchain version
		
		console.log('Error: Debt ID did not match onchain version');
	}
}


/*
  Calls on the CashScript contract to validate the debt obligation ID being used 
 */
async function validateTokenId(localId, onchainId) {

	try {
		// Calls the validateTokenId function in cashscript and returns true if require() succeeds
		// note the '.send()' is needed so the validation is carried out on the network, otherwise
		//	it is no different than a local client side validation.
		var tx = await instance.functions.validateTokenID(localId, onchainId).send(instance.address,1);
		
		return true;
		
	} catch (error) {
		if (error instanceof FailedRequireError) { // returns false if require() comparison fails
			console.log('Error: token ID mismatch, exiting audit.');
			return false;
		} else {
			console.log('Error: ' + error);
			return false;
		}
	}
}

/*
  Checks the current BCH USD price via Bitbox
 */
async function validateBchPrice() {
	try {
		let currentPrice = await bitbox.Price.current('usd');  
		console.log('current price: ' + (currentPrice/60));
		if (currentPrice < (bchUSDThreashold*60)) {
			console.log('Debt covenant breached, calculating repayment to creditors');
			return true; // debt covenant has been breached
		} else {
			console.log('Debt covenant still in tact, exiting audit');
			process.exit(1)
		}
    } catch(error) {
		console.error(error);
		console.log('Exiting audit');
		process.exit(1)
	}
}

/*
  Distribution of the BCH from the collateralFund address to 
  holders of the debt obligation token 
 */
async function releaseCollateral(debtObHolders, distributionRate, debtObAddrCount) {

  try {
    
    // convert cash addresses into legacy addresses
    const SEND_ADDR_LEGACY = bitbox.Address.toLegacyAddress(bchCollateralAddress);
    
    // retrieve utxos of the address holding the BCH collateral
    const u = await bitbox.Address.utxo(bchCollateralAddress);
    const utxo = findBiggestUtxo(u.utxos);
    const originalAmount = utxo.satoshis;
    const vout = utxo.vout;
    const txid = utxo.txid;
    
    // initiates TransactionBuilder on the selected network
    const transactionBuilder = new bitbox.TransactionBuilder(network);
    
    // get byte count to calculate fee. paying 1.2 sat/byte
    const byteCount = 300 * debtObAddrCount; // 300 bytes per creditor output
    console.log(`byteCount: ${byteCount}`);
    const satoshisPerByte = 1.2;
    const txFee = Math.floor(satoshisPerByte * byteCount);
    console.log(`txFee: ${txFee}`);
    
    // add input with txid and index of vout
    transactionBuilder.addInput(txid, vout);
     
    var totalSatsForDistribution = 0; // tracks the total sats for distribution
    
    // iteration through array of token holders to send alloted BCH
	for (var i = 0; i < debtObAddrCount; i++) {
		var sendAmountBch = debtObHolders[i].tokenBalance * distributionRate; // calculate the correct BCH to send
		var sendAmountSat = Math.floor(bitbox.BitcoinCash.toSatoshi(sendAmountBch)); // convert from BCH to SATs
		var receiveAddress = SLP.Address.toCashAddress(debtObHolders[i].slpAddress);
		
		console.log('\nAdding output #: ' + (i+1) + ' of ' + debtObAddrCount + ' creditor(s)\nSending ' 
		+ sendAmountBch + ' bch to ' + receiveAddress);

		// retrieve the corresponding cash address for each SLP address
		const RECV_ADDR_LEGACY = bitbox.Address.toLegacyAddress(receiveAddress);

		// keep track of total sats for this tx
		totalSatsForDistribution = totalSatsForDistribution + sendAmountSat;
		
		// add output w/ address and amount to send
		transactionBuilder.addOutput(receiveAddress, sendAmountSat);
		
	}

    // amount to send back to the sending address.
    // It's the original amount - 1.2 sat/byte for tx size
    const remainder = originalAmount - totalSatsForDistribution - txFee;
	
	// final output for the remainder sats to return to the sender
	transactionBuilder.addOutput(bchCollateralAddress, remainder); 

    // since satoshi's can't be fractional at time of code
    const satoshisToSend = Math.floor(totalSatsForDistribution - txFee);
	  
    // Generate a change address from a Mnemonic of a private key.
    const change = changeAddrFromMnemonic(smartContractMnemonic)

    // Generate a keypair from the change address.
    const keyPair = bitbox.HDNode.toKeyPair(change)

    // Sign the transaction with the HD node.
    let redeemScript
    transactionBuilder.sign(
      0,
      keyPair,
      redeemScript,
      transactionBuilder.hashTypes.SIGHASH_ALL,
      originalAmount
    )

    // build tx
    const tx = transactionBuilder.build()
    // output rawhex
    const hex = tx.toHex()

    // Broadcast transation to the network
    const txidStr = await bitbox.RawTransactions.sendRawTransaction([hex])
    console.log(`\nCreditor repayments successfully broadcasted to network\nTransaction ID: ${txidStr}`)
         
  } catch (err) {
    console.log(`error: `, err)
  }
}
  
// *** Helpder functions imported from Bitbox SDK below ***

/*
  Generate a change address from a Mnemonic of a private key.
 */
function changeAddrFromMnemonic(mnemonic, network) {
  const rootSeed = bitbox.Mnemonic.toSeed(mnemonic)
  const masterHDNode = bitbox.HDNode.fromSeed(rootSeed, network)
  const account = bitbox.HDNode.derivePath(masterHDNode, "m/44'/145'/0'")

  // derive the first external change address HDNode which is going to spend utxo
  const change = bitbox.HDNode.derivePath(account, "0/0")
  return change
}

/*
  Get the balance in BCH of a BCH address.
 */
async function getBCHBalance(addr, verbose) {
  try {
    const bchBalance = await bitbox.Address.details(addr)

    if (verbose) console.log(bchBalance)

    return bchBalance.balance
  } catch (err) {
    console.error(`Error in getBCHBalance: `, err)
    console.log(`addr: ${addr}`)
    throw err
  }
}

/*
  Returns the utxo with the biggest balance from an array of utxos.
 */
function findBiggestUtxo(utxos) {
  let largestAmount = 0
  let largestIndex = 0

  for (let i = 0; i < utxos.length; i++) {
    const thisUtxo = utxos[i]

    if (thisUtxo.satoshis > largestAmount) {
      largestAmount = thisUtxo.satoshis
      largestIndex = i
    }
  }

  return utxos[largestIndex]
}
  
  
module.exports = {
  checkDebtCovenant,
};
