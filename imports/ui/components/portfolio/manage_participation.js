import { Meteor } from 'meteor/meteor';
import { Template } from 'meteor/templating';
import { FlowRouter } from 'meteor/kadira:flow-router';
import { Session } from 'meteor/session';
import { ReactiveVar } from 'meteor/reactive-var';
import select2 from 'select2';
// Collections
import { Cores } from '/imports/api/cores';
// Contracts
import Core from '/imports/lib/assets/contracts/Core.sol.js';
import './manage_participation.html';


Template.manage_participation.onCreated(() => {
  // TODO update cores param
  Meteor.subscribe('cores');
  Template.instance().typeValue = new ReactiveVar(0);
  // Creation of contract object
  Core.setProvider(web3.currentProvider);
});


Template.manage_participation.helpers({
  getPortfolioDoc() {
    const address = FlowRouter.getParam('address');
    const doc = Cores.findOne({ address });
    return (doc === undefined || address === undefined) ? '' : doc;
  },
  formattedSharePrice() {
    const address = FlowRouter.getParam('address');
    const doc = Cores.findOne({ address });
    if (doc !== undefined) {
      return web3.fromWei(doc.sharePrice, 'ether');
    }
    return '';
  },
  selectedTypeName() {
    switch (Template.instance().typeValue.get()) {
      case 0: return 'Invest';
      case 1: return 'Redeem';
      default: return 'Error';
    }
  },
});

Template.manage_participation.onRendered(() => {
  $('select').select2();
  // Sync core and
  const address = FlowRouter.getParam('address');
  Meteor.call('cores.sync', address); // Upsert cores Collection
  Meteor.call('assets.sync', address); // Upsert Assets Collection

});


Template.manage_participation.events({
  'change select#type': (event, templateInstance) => {
    const currentlySelectedTypeValue = parseFloat(templateInstance.find('select#type').value, 10);
    Template.instance().typeValue.set(currentlySelectedTypeValue);
  },
  'input input#price': (event, templateInstance) => {
    const price = parseFloat(templateInstance.find('input#price').value, 10);
    const volume = parseFloat(templateInstance.find('input#volume').value, 10);
    const total = parseFloat(templateInstance.find('input#total').value, 10);
    if (!isNaN(volume)) templateInstance.find('input#total').value = price * volume;
    else if (!isNaN(total)) templateInstance.find('input#volume').value = total / price;
  },
  'input input#volume': (event, templateInstance) => {
    const price = parseFloat(templateInstance.find('input#price').value, 10);
    const volume = parseFloat(templateInstance.find('input#volume').value, 10);
    /* eslint no-param-reassign: ["error", { "props": false }]*/
    templateInstance.find('input#total').value = price * volume;
  },
  'input input#total': (event, templateInstance) => {
    const price = parseFloat(templateInstance.find('input#price').value, 10);
    const total = parseFloat(templateInstance.find('input#total').value, 10);
    /* eslint no-param-reassign: ["error", { "props": false }]*/
    templateInstance.find('input#volume').value = total / price;
  },
  'click .manage': (event, templateInstance) => {
    // Prevent default browser form submit
    event.preventDefault();

    // Get value from template instance
    const type = parseFloat(templateInstance.find('select#type').value, 10);
    const price = parseFloat(templateInstance.find('input#price').value, 10);
    const volume = parseFloat(templateInstance.find('input#volume').value, 10);
    const total = parseFloat(templateInstance.find('input#total').value, 10);
    if (isNaN(type) || isNaN(price) || isNaN(volume) || isNaN(total)) {
      //TODO replace toast
      // Materialize.toast('Please fill out the form', 4000, 'blue');
      return;
    }

    // Init
    const managerAddress = Session.get('clientManagerAccount');
    if (managerAddress === undefined) {
      //TODO replace toast
      // Materialize.toast('Not connected, use Parity, Mist or MetaMask', 4000, 'blue');
      return;
    }
    const coreAddress = FlowRouter.getParam('address');
    const doc = Cores.findOne({ address: coreAddress });
    // Check if core is stored in database
    if (doc === undefined) {
      //TODO replace toast
      // Materialize.toast(`Portfolio could not be found\n ${coreAddress}`, 4000, 'red');
      return;
    }
    const coreContract = Core.at(coreAddress);

    // Is mining
    Session.set('NetworkStatus', { isInactive: false, isMining: true, isError: false, isMined: false });

    // From price to volume of shares
    const weiPrice = web3.toWei(price, 'ether');
    const weiVolume = web3.toWei(volume, 'ether');
    const weiTotal = web3.toWei(total, 'ether');

    // Invest or Redeem
    // TODO use switch as above
    if (type === 0) {
      coreContract.createShares(weiTotal, { value: weiVolume, from: managerAddress }).then((result) => {
        Session.set('NetworkStatus', { isInactive: false, isMining: false, isError: false, isMined: true });
        // TODO insert txHash into appropriate collection
        console.log(`Tx Hash: ${result}`);
        Meteor.call('cores.sync', coreAddress); // Upsert cores Collection
        Meteor.call('assets.sync', coreAddress); // Upsert Assets Collection
        return coreContract.totalSupply();
      });
    } else if (type === 1) {
      coreContract.annihilateShares(weiVolume, weiTotal, { from: managerAddress }).then((result) => {
        Session.set('NetworkStatus', { isInactive: false, isMining: false, isError: false, isMined: true });
        // TODO insert txHash into appropriate collection
        console.log(`Tx Hash: ${result}`);
        Meteor.call('cores.sync', coreAddress); // Upsert cores Collection
        Meteor.call('assets.sync', coreAddress); // Upsert Assets Collection
        return coreContract.totalSupply();
      });
    }
  },
});
