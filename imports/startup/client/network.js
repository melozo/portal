/// Remark: Code mostly taken from: https://github.com/makerdao/maker-market
import { Meteor } from 'meteor/meteor';
import { Session } from 'meteor/session';
import { _ } from 'meteor/underscore';

// Check which accounts are available and if defaultAccount is still available,
// Otherwise set it to localStorage, Session, or first element in accounts
function checkAccounts() {
  web3.eth.getAccounts((error, accounts) => {
    if (!error) {
      if (!_.contains(accounts, web3.eth.defaultAccount)) {
        if (_.contains(accounts, localStorage.getItem('clientManagerAccount'))) {
          web3.eth.defaultAccount = localStorage.getItem('clientManagerAccount');
        } else if (_.contains(accounts, Session.get('clientManagerAccount'))) {
          web3.eth.defaultAccount = Session.get('clientManagerAccount');
        } else if (accounts.length > 0) {
          web3.eth.defaultAccount = accounts[0];
        } else {
          web3.eth.defaultAccount = undefined;
        }
      }
      localStorage.setItem('clientManagerAccount', web3.eth.defaultAccount);
      web3.eth.getBalance(web3.eth.defaultAccount, (error, result) => {
        if(!error) {
          Session.set('clientManagerAccountBalance', result.toNumber());
        } else {
          Session.set('clientManagerAccountBalance', undefined);
        }
      });
      Session.set('clientManagerAccount', web3.eth.defaultAccount);
      Session.set('getAccountCount', accounts.length);
      Session.set('clientAccountList', accounts);
    }
  });
}

// Initialize everything on new network
function initNetwork(newNetwork) {
  checkAccounts();
  Session.set('network', newNetwork);
  Session.set('isClientConnected', true);
  Session.set('latestBlock', 0);
  Session.set('startBlock', 0);
}

// CHECK FOR NETWORK
function checkNetwork() {
  web3.version.getNode((error) => {
    const isClientConnected = !error;

    // Check if we are synced
    if (isClientConnected) {
      web3.eth.getBlock('latest', (e, res) => {
        if (res.number >= Session.get('latestBlock')) {
          Session.set('outOfSync', e != null || (new Date().getTime() / 1000) - res.timestamp > 600);
          Session.set('latestBlock', res.number);
          if (Session.get('startBlock') === 0) {
            Session.set('startBlock', (res.number - 6000));
          }
        } else {
          // XXX MetaMask frequently returns old blocks
          // https://github.com/MetaMask/metamask-plugin/issues/504
          console.debug('Skipping old block');
        }
      });
    }

    // Check which network are we connected to
    // https://github.com/ethereum/meteor-dapp-wallet/blob/90ad8148d042ef7c28610115e97acfa6449442e3/app/client/lib/ethereum/walletInterface.js#L32-L46
    if (!Session.equals('isClientConnected', isClientConnected)) {
      if (isClientConnected === true) {
        web3.eth.getBlock(0, (e, res) => {
          let network = false;
          if (!e) {
            switch (res.hash) {
              case '0x0cd786a2425d16f152c658316c423e6ce1181e15c3295826d7c9904cba9ce303':
                network = 'Morden';
                break;
              case '0x41941023680923e0fe4d74a34bdac8141f2540e3ae90623718e47d66d1ca4a2d':
                network = 'Ropsten';
                break;
              case '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3':
                network = 'Main';
                break;
              default:
                network = 'Private';
            }
          }
          if (!Session.equals('network', network)) {
            initNetwork(network, isClientConnected);
          }
        });
      } else {
        Session.set('isClientConnected', isClientConnected);
        Session.set('network', false);
        Session.set('latestBlock', 0);
      }
    }
  });
}

function initSession() {
  Session.set('network', false);
  Session.set('loading', false);
  Session.set('outOfSync', false);
  Session.set('syncing', false);
  Session.set('isClientConnected', false);
  Session.set('isServerConnected', true);
  Session.set('latestBlock', 0);
}

function checkIfSynching() {
  web3.eth.isSyncing((error, sync) => {
    if (!error) {
      Session.set('syncing', sync !== false);

      // Stop all app activity
      if (sync === true) {
        // We use `true`, so it stops all filters, but not the web3.eth.syncing polling
        web3.reset(true);
        checkNetwork();
      // show sync info
      } else if (sync) {
        Session.set('startingBlock', sync.startingBlock);
        Session.set('currentBlock', sync.currentBlock);
        Session.set('highestBlock', sync.highestBlock);
      } else {
        Session.set('outOfSync', false);
      }
    }
  });
}

function checkIfServerIsConncected() {
  Meteor.call('isServerConnected', (err, result) => {
    if(!err) {
      Session.set('isServerConnected', result);
    } else {
      console.log(err);
    }
  });
}

function getTestnetEther() {
  if (Session.get('network') === 'Ropsten' && Session.get('clientManagerAccountBalance') <= web3.toWei('1', 'ether')) {
    const address = Session.get('clientManagerAccount');
    // TODO outsource in library
    Meteor.call('sendTestnetEther', address, (err, res) => {
      if (!err) {
        //TODO replace toast
        // Materialize.toast('We\'ve seen you\'re low on cash so requested some for you.', 30000, 'green');
        const amount = parseInt(web3.fromWei(parseInt(res.data, 10), 'ether'), 10);
        const msg = res.message;
        if (amount === 0) {
          //TODO replace toast
          // Materialize.toast(`Ethereum Faucet says: "${msg}"`, 30000, 'red');
          //TODO replace toast
          // Materialize.toast(`Go to: https://faucet.metamask.io/ for an alternative faucet`, 30000, 'blue');
        } else {
          //TODO replace toast
          // Materialize.toast(`Sent ${amount} ETH to your account.  Wait a few seconds and let it rain!`, 30000, 'green');
        }
      } else {
        console.log(err);
      }
    });
  }
}

// EXECUTION
Meteor.startup(() => {
  initSession();
  checkNetwork();
  checkIfSynching();
  checkIfServerIsConncected();

  Meteor.setInterval(getTestnetEther, 30 * 1000);
  Meteor.setInterval(checkNetwork, 2503);
});
