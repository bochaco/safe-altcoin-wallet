/*
  Module which takes care of the SAFE Network altcoins wallet functioning
*/
const crypto = require('crypto');

const ACTION_INSERT = 'Insert';

const TYPE_TAG_WALLET = 1012017;
const TYPE_TAG_WALLET_TX_INBOX = 20082018;
const TYPE_TAG_THANKS_COIN = 21082018;

const COIN_ENTRY_KEY_DATA = 'coin-data';

const TX_INBOX_ENTRY_KEY_ENC_PK = '__tx_enc_pk';
const TX_INBOX_ENTRY_KEY_WALLET_PK = '__wallet_pk';
const TX_INBOX_METADATA_NAME = 'ThanksCoins TX Inbox';
const TX_INBOX_METADATA_DESC = 'Container to receive notifications of ThanksCoins transactions';

const WALLET_ENTRY_KEY_COINS = '__coins';
const WALLET_METADATA_NAME = 'ThanksCoins Wallet';
const WALLET_METADATA_DESC = 'Container to store the list of ThanksCoins addresses owned';

const ENTRY_KEY_MD_METADATA = '_metadata';

// Generic Helper functions
const _fromArrayBuffer = (buf) => String.fromCharCode.apply(null, new Uint8Array(buf));
const _genXorName = (safeApp, str) => safeApp.crypto.sha3Hash(str || '');

// Altcoin Wallet management functions
const _readEncryptedEntry = async (md, key) => {
  const encKey = await md.encryptKey(key);
  const encValue = await md.get(encKey);
  return md.decrypt(encValue.buf);
}

const _insertEntriesEncrypted = async (safeApp, md, data) => {
  const mutations = await safeApp.mutableData.newMutation();
  await Promise.all(Object.keys(data).map(async (key) => {
      const encKey = await md.encryptKey(key);
      const encValue = await md.encryptValue(data[key]);
      return mutations.insert(encKey, encValue);
    }));

  await md.applyEntriesMutation(mutations);
}

const createWallet = async (safeApp, pk) => {
  console.log("Creating the coin wallet...");
  const emptyCoins = {
    [WALLET_ENTRY_KEY_COINS]: JSON.stringify([])
  };

  const encKeyPair = await safeApp.crypto.generateEncKeyPair();
  const secEncKey = await encKeyPair.secEncKey.getRaw();
  const nonce = await safeApp.crypto.generateNonce();
  const xorName = await _genXorName(safeApp, pk);
  const walletMd = await safeApp.mutableData.newPrivate(xorName, TYPE_TAG_WALLET, secEncKey, nonce);
  await walletMd.quickSetup({}, WALLET_METADATA_NAME, WALLET_METADATA_DESC); // TODO: support the case that it exists already
  await _insertEntriesEncrypted(safeApp, walletMd, emptyCoins);
  const serialisedWallet = await walletMd.serialise();
  const walletArr = new Uint8Array(serialisedWallet);
  return walletArr.toString();
}

const _deserialiseArray = (strOrBuffer) => {
  let arrItems = strOrBuffer.split(',');
  return Uint8Array.from(arrItems);
}

const loadWalletData = async (safeApp, serialisedWallet) => {
  console.log("Reading the coin wallet info...");
  const deserialisedWallet = _deserialiseArray(serialisedWallet);
  const walletMd = await safeApp.mutableData.fromSerial(deserialisedWallet);
  const coins = await _readEncryptedEntry(walletMd, WALLET_ENTRY_KEY_COINS);
  return JSON.parse(_fromArrayBuffer(coins));
}

const storeCoinsToWallet = async (safeApp, serialisedWallet, coins) => {
  console.log("Saving coins in the wallet on the network...");
  const walletMd = await safeApp.mutableData.fromSerial(_deserialiseArray(serialisedWallet));
  const encKey = await walletMd.encryptKey(WALLET_ENTRY_KEY_COINS);
  const currentCoins = await walletMd.get(encKey);
  const mutations = await safeApp.mutableData.newMutation();
  const encValue = await walletMd.encryptValue(JSON.stringify(coins));
  await mutations.update(encKey, encValue, currentCoins.version + 1);
  await walletMd.applyEntriesMutation(mutations);
}

// TX Inbox management functions
const _genKeyPair = async (safeApp) => {
  const encKeyPair = await safeApp.crypto.generateEncKeyPair();
  const rawPubEncKey = await encKeyPair.pubEncKey.getRaw();
  const rawSecEncKey = await encKeyPair.secEncKey.getRaw();
  const rawKeyPair = {
    pk: rawPubEncKey.buffer.toString('hex'),
    sk: rawSecEncKey.buffer.toString('hex')
  };
  return rawKeyPair;
}

const createTxInbox = async (safeApp, pk) => {
  console.log("Creating TX inbox...");
  const encKeys = await _genKeyPair(safeApp);
  const baseInbox = {
    [TX_INBOX_ENTRY_KEY_WALLET_PK]: pk,
    [TX_INBOX_ENTRY_KEY_ENC_PK]: encKeys.pk
  };
  const xorName = await _genXorName(safeApp, pk);
  const inboxMd = await safeApp.mutableData.newPublic(xorName, TYPE_TAG_WALLET_TX_INBOX);
  await inboxMd.quickSetup(baseInbox, TX_INBOX_METADATA_NAME, TX_INBOX_METADATA_DESC);
  const permSet = [ ACTION_INSERT ];
  await inboxMd.setUserPermissions(window.safe.CONSTANTS.USER_ANYONE, permSet, 1);
  return encKeys;
}

const _encrypt = async (safeApp, input, pk) => {
  if (Array.isArray(input)) {
    input = input.toString();
  }

  const pubEncKey = await safeApp.crypto.pubEncKeyFromRaw(Buffer.from(pk, 'hex'));
  const encrypted = await pubEncKey.encryptSealed(input);
  return encrypted;
};

const _decryptTxs = async (safeApp, encryptedTxs, encPk, encSk) => {
  return Promise.all(encryptedTxs.map(async (encTx) => {
      const rawPk = Buffer.from(encPk, 'hex');
      const rawSk = Buffer.from(encSk, 'hex');
      const encKeyPair = await safeApp.crypto.generateEncKeyPairFromRaw(rawPk, rawSk);
      const decrypted = await encKeyPair.decryptSealed(encTx.txInfo);
      const parsedTxInfo = JSON.parse(_fromArrayBuffer(decrypted));
      return { id: encTx.id, version: encTx.version, ...parsedTxInfo };
    }));
}

const readTxInboxData = async (safeApp, pk, encPk, encSk) => {
  let encryptedTxs = [];
  const xorName = await _genXorName(safeApp, pk);
  const inboxMd = await safeApp.mutableData.newPublic(xorName, TYPE_TAG_WALLET_TX_INBOX);
  const entries = await inboxMd.getEntries();
  const entriesList = await entries.listEntries();
  entriesList.forEach((entry) => {
      const id = _fromArrayBuffer(entry.key);
      const txInfo = entry.value.buf;
      // Ignore the Public encryption key entry, the metadata entry, and soft-deleted entries.
      if (id !== TX_INBOX_ENTRY_KEY_WALLET_PK
          && id !== TX_INBOX_ENTRY_KEY_ENC_PK
          && id !== ENTRY_KEY_MD_METADATA
          && txInfo.length > 0)
      {
        encryptedTxs.push({ id, txInfo, version: entry.value.version });
      }
    });
  const decryptedTxs = await _decryptTxs(safeApp, encryptedTxs, encPk, encSk);
  return decryptedTxs;
}

const removeTxInboxData = async (safeApp, pk, txs) => {
  const mutations = await safeApp.mutableData.newMutation();
  await Promise.all(txs.map((tx) => mutations.delete(tx.id, tx.version + 1)));
  const xorName = await _genXorName(safeApp, pk);
  const txInboxMd = await safeApp.mutableData.newPublic(xorName, TYPE_TAG_WALLET_TX_INBOX);
  await txInboxMd.applyEntriesMutation(mutations);
}

const fetchTxInbox = async (safeApp, recipient) => {
  let xorName;
  let typeTag;

  if (recipient.toLowerCase().startsWith('safe://')) {
    // the recipient is a WebID, let's resolve the linked wallet TX inbox
    console.log('Fetching WebID:', recipient);
    const { serviceMd: webIdMd, type } = await safeApp.fetch( recipient );
    if ( type !== 'RDF' ) throw 'Service is not mapped to a WebID RDF';

    const webIdRdf = webIdMd.emulateAs( 'rdf' );
    await webIdRdf.nowOrWhenFetched();

    const baseUri = recipient.split( '#' )[0];
    const walletGraph = webIdRdf.sym(`${baseUri}/walletInbox`);

    const SAFETERMS = webIdRdf.namespace( 'http://safenetwork.org/safevocab/' );
    const xornameMatch = webIdRdf.statementsMatching( walletGraph, SAFETERMS( 'xorName' ), undefined );
    if (!xornameMatch[0]) {
      throw Error('No wallet TX inbox link found in WebID');
    }
    xorName = xornameMatch[0].object.value.split( ',' );
    const typetagMatch = webIdRdf.statementsMatching( walletGraph, SAFETERMS( 'typeTag' ), undefined );
    if (!typetagMatch[0]) {
      throw Error('Wallet TX inbox link found in WebID lacks information');
    }
    typeTag = parseInt( typetagMatch[0].object.value );
  } else {
    // recipient is just a PK
    xorName = await _genXorName(safeApp, recipient);
    typeTag = TYPE_TAG_WALLET_TX_INBOX;
  }

  const txInboxMd = await safeApp.mutableData.newPublic(xorName, typeTag);
  return txInboxMd;
};

const sendTxNotif = async (safeApp, recipient, coinIds, msg) => {
  const txId = crypto.randomBytes(16).toString('hex');
  const tx = {
    coinIds: coinIds,
    msg: msg,
    date: (new Date()).toUTCString()
  };
  const txNotif = JSON.stringify(tx);

  // we expect the recipient to be a pk but it will also work if it's a WebID
  console.log("Sending TX notification to recipient. TX id: ", txId);
  const txInboxMd = await fetchTxInbox(safeApp, recipient);
  const encPk = await txInboxMd.get(TX_INBOX_ENTRY_KEY_ENC_PK);
  const encryptedTx = await _encrypt(safeApp, txNotif, encPk.buf.toString());
  const mutations = await safeApp.mutableData.newMutation();
  await mutations.insert(txId, encryptedTx);
  await txInboxMd.applyEntriesMutation(mutations);
}

const _checkOwnership = (coin, pk) => {
  const coinData = JSON.parse(coin);
  console.log("Coin data: ", coinData);
  if (coinData.owner !== pk) {
    throw Error("Ownership doesn't match", pk, coinData);
  }
  return coinData;
}

const _fetchCoin = async (safeApp, coinId) => {
  const coinMd = await safeApp.mutableData.newPublic(Buffer.from(coinId, 'hex'), TYPE_TAG_THANKS_COIN);
  const coin = await coinMd.get(COIN_ENTRY_KEY_DATA);
  return { coin, coinMd };
}

const checkOwnership = async (safeApp, coinId, pk) => {
  console.log("Reading coin data...", pk, coinId);
  const { coin, coinMd } = await _fetchCoin(safeApp, coinId);
  return _checkOwnership(coin.buf.toString(), pk);
}

const transferCoin = async (safeApp, coinId, pk, sk, recipient) => {
  console.log("Transfering coin's ownership in the network...", coinId, recipient);
  const { coin, coinMd } = await _fetchCoin(safeApp, coinId);
  let coinData = _checkOwnership(coin.buf.toString(), pk);
  const txInboxMd = await fetchTxInbox(safeApp, recipient);
  const recipientPk = await txInboxMd.get(TX_INBOX_ENTRY_KEY_WALLET_PK);
  const recipientPkStr = recipientPk.buf.toString();
  coinData.owner = recipientPkStr;
  coinData.prev_owner = pk;
  console.log("Coin's new ownership: ", coinData);
  const mutations = await safeApp.mutableData.newMutation();
  await mutations.update(COIN_ENTRY_KEY_DATA, JSON.stringify(coinData), coin.version + 1);
  await coinMd.applyEntriesMutation(mutations);
  return recipientPkStr;
}

export const updateLinkInWebId = async (safeApp, webIdUrl, txInboxPk) => {
  console.log("Updating link in WebID:", webIdUrl, txInboxPk);

  const { serviceMd: webIdMd, type } = await safeApp.fetch( webIdUrl );
  if ( type !== 'RDF' ) throw 'Service is not mapped to a WebID RDF';

  const webIdRdf = webIdMd.emulateAs( 'rdf' );
  await webIdRdf.nowOrWhenFetched();

  const baseUri = webIdUrl.split( '#' )[0];
  const walletGraph = webIdRdf.sym(`${baseUri}/walletInbox`);
  webIdRdf.removeMany(walletGraph, undefined, undefined);

  if (txInboxPk) {
    const RDFS = webIdRdf.namespace( 'http://www.w3.org/1999/02/22-rdf-syntax-ns#' );
    const WALLETTERMS = webIdRdf.namespace( 'https://w3id.org/cc#' );
    webIdRdf.add(walletGraph, RDFS('type'), WALLETTERMS('inbox'));
    const DCTERMS = webIdRdf.namespace( 'http://purl.org/dc/terms/' );
    webIdRdf.add(walletGraph, DCTERMS('title'), webIdRdf.literal('ThanksCoin wallet TX inbox'));
    const xorName = await _genXorName(safeApp, txInboxPk);
    const SAFETERMS = webIdRdf.namespace( 'http://safenetwork.org/safevocab/' );
    webIdRdf.add(walletGraph, SAFETERMS('xorName'), webIdRdf.literal((new Uint8Array(xorName)).toString()));
    webIdRdf.add(walletGraph, SAFETERMS('typeTag'), webIdRdf.literal(`${TYPE_TAG_WALLET_TX_INBOX}`));
  }

  try {
    await webIdRdf.commit();
  } catch(error) {
    const nameAndTag = await webIdMd.getNameAndTag();
    console.log("Authorising application to update WebID...");
    const authReqUri = await safeApp.auth.genShareMDataUri([
      {
        typeTag: nameAndTag.typeTag,
        name: nameAndTag.name,
        perms: ['Insert', 'Update', 'Delete']
      }
    ]);
    const authUri = await window.safe.authorise(authReqUri);
    await safeApp.auth.loginFromUri(authUri);
    await safeApp.auth.refreshContainersPermissions();
    console.log("Committing update in WebID now...");
    await webIdRdf.commit();
  }

  console.log("WebID updated with new link to TX inbox");
}

module.exports = {
  createWallet,
  loadWalletData,
  storeCoinsToWallet,
  createTxInbox,
  readTxInboxData,
  removeTxInboxData,
  sendTxNotif,
  checkOwnership,
  transferCoin,
  updateLinkInWebId
};
