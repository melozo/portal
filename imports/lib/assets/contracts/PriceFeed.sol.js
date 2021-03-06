var Web3 = require("web3");
var SolidityEvent = require("web3/lib/web3/event.js");

(function() {
  // Planned for future features, logging, etc.
  function Provider(provider) {
    this.provider = provider;
  }

  Provider.prototype.send = function() {
    this.provider.send.apply(this.provider, arguments);
  };

  Provider.prototype.sendAsync = function() {
    this.provider.sendAsync.apply(this.provider, arguments);
  };

  var BigNumber = (new Web3()).toBigNumber(0).constructor;

  var Utils = {
    is_object: function(val) {
      return typeof val == "object" && !Array.isArray(val);
    },
    is_big_number: function(val) {
      if (typeof val != "object") return false;

      // Instanceof won't work because we have multiple versions of Web3.
      try {
        new BigNumber(val);
        return true;
      } catch (e) {
        return false;
      }
    },
    merge: function() {
      var merged = {};
      var args = Array.prototype.slice.call(arguments);

      for (var i = 0; i < args.length; i++) {
        var object = args[i];
        var keys = Object.keys(object);
        for (var j = 0; j < keys.length; j++) {
          var key = keys[j];
          var value = object[key];
          merged[key] = value;
        }
      }

      return merged;
    },
    promisifyFunction: function(fn, C) {
      var self = this;
      return function() {
        var instance = this;

        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {
          var callback = function(error, result) {
            if (error != null) {
              reject(error);
            } else {
              accept(result);
            }
          };
          args.push(tx_params, callback);
          fn.apply(instance.contract, args);
        });
      };
    },
    synchronizeFunction: function(fn, instance, C) {
      var self = this;
      return function() {
        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {

          var decodeLogs = function(logs) {
            return logs.map(function(log) {
              var logABI = C.events[log.topics[0]];

              if (logABI == null) {
                return null;
              }

              var decoder = new SolidityEvent(null, logABI, instance.address);
              return decoder.decode(log);
            }).filter(function(log) {
              return log != null;
            });
          };

          var callback = function(error, tx) {
            if (error != null) {
              reject(error);
              return;
            }

            var timeout = C.synchronization_timeout || 240000;
            var start = new Date().getTime();

            var make_attempt = function() {
              C.web3.eth.getTransactionReceipt(tx, function(err, receipt) {
                if (err) return reject(err);

                if (receipt != null) {
                  // If they've opted into next gen, return more information.
                  if (C.next_gen == true) {
                    return accept({
                      tx: tx,
                      receipt: receipt,
                      logs: decodeLogs(receipt.logs)
                    });
                  } else {
                    return accept(tx);
                  }
                }

                if (timeout > 0 && new Date().getTime() - start > timeout) {
                  return reject(new Error("Transaction " + tx + " wasn't processed in " + (timeout / 1000) + " seconds!"));
                }

                setTimeout(make_attempt, 1000);
              });
            };

            make_attempt();
          };

          args.push(tx_params, callback);
          fn.apply(self, args);
        });
      };
    }
  };

  function instantiate(instance, contract) {
    instance.contract = contract;
    var constructor = instance.constructor;

    // Provision our functions.
    for (var i = 0; i < instance.abi.length; i++) {
      var item = instance.abi[i];
      if (item.type == "function") {
        if (item.constant == true) {
          instance[item.name] = Utils.promisifyFunction(contract[item.name], constructor);
        } else {
          instance[item.name] = Utils.synchronizeFunction(contract[item.name], instance, constructor);
        }

        instance[item.name].call = Utils.promisifyFunction(contract[item.name].call, constructor);
        instance[item.name].sendTransaction = Utils.promisifyFunction(contract[item.name].sendTransaction, constructor);
        instance[item.name].request = contract[item.name].request;
        instance[item.name].estimateGas = Utils.promisifyFunction(contract[item.name].estimateGas, constructor);
      }

      if (item.type == "event") {
        instance[item.name] = contract[item.name];
      }
    }

    instance.allEvents = contract.allEvents;
    instance.address = contract.address;
    instance.transactionHash = contract.transactionHash;
  };

  // Use inheritance to create a clone of this contract,
  // and copy over contract's static functions.
  function mutate(fn) {
    var temp = function Clone() { return fn.apply(this, arguments); };

    Object.keys(fn).forEach(function(key) {
      temp[key] = fn[key];
    });

    temp.prototype = Object.create(fn.prototype);
    bootstrap(temp);
    return temp;
  };

  function bootstrap(fn) {
    fn.web3 = new Web3();
    fn.class_defaults  = fn.prototype.defaults || {};

    // Set the network iniitally to make default data available and re-use code.
    // Then remove the saved network id so the network will be auto-detected on first use.
    fn.setNetwork("default");
    fn.network_id = null;
    return fn;
  };

  // Accepts a contract object created with web3.eth.contract.
  // Optionally, if called without `new`, accepts a network_id and will
  // create a new version of the contract abstraction with that network_id set.
  function Contract() {
    if (this instanceof Contract) {
      instantiate(this, arguments[0]);
    } else {
      var C = mutate(Contract);
      var network_id = arguments.length > 0 ? arguments[0] : "default";
      C.setNetwork(network_id);
      return C;
    }
  };

  Contract.currentProvider = null;

  Contract.setProvider = function(provider) {
    var wrapped = new Provider(provider);
    this.web3.setProvider(wrapped);
    this.currentProvider = provider;
  };

  Contract.new = function() {
    if (this.currentProvider == null) {
      throw new Error("PriceFeed error: Please call setProvider() first before calling new().");
    }

    var args = Array.prototype.slice.call(arguments);

    if (!this.unlinked_binary) {
      throw new Error("PriceFeed error: contract binary not set. Can't deploy new instance.");
    }

    var regex = /__[^_]+_+/g;
    var unlinked_libraries = this.binary.match(regex);

    if (unlinked_libraries != null) {
      unlinked_libraries = unlinked_libraries.map(function(name) {
        // Remove underscores
        return name.replace(/_/g, "");
      }).sort().filter(function(name, index, arr) {
        // Remove duplicates
        if (index + 1 >= arr.length) {
          return true;
        }

        return name != arr[index + 1];
      }).join(", ");

      throw new Error("PriceFeed contains unresolved libraries. You must deploy and link the following libraries before you can deploy a new version of PriceFeed: " + unlinked_libraries);
    }

    var self = this;

    return new Promise(function(accept, reject) {
      var contract_class = self.web3.eth.contract(self.abi);
      var tx_params = {};
      var last_arg = args[args.length - 1];

      // It's only tx_params if it's an object and not a BigNumber.
      if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
        tx_params = args.pop();
      }

      tx_params = Utils.merge(self.class_defaults, tx_params);

      if (tx_params.data == null) {
        tx_params.data = self.binary;
      }

      // web3 0.9.0 and above calls new twice this callback twice.
      // Why, I have no idea...
      var intermediary = function(err, web3_instance) {
        if (err != null) {
          reject(err);
          return;
        }

        if (err == null && web3_instance != null && web3_instance.address != null) {
          accept(new self(web3_instance));
        }
      };

      args.push(tx_params, intermediary);
      contract_class.new.apply(contract_class, args);
    });
  };

  Contract.at = function(address) {
    if (address == null || typeof address != "string" || address.length != 42) {
      throw new Error("Invalid address passed to PriceFeed.at(): " + address);
    }

    var contract_class = this.web3.eth.contract(this.abi);
    var contract = contract_class.at(address);

    return new this(contract);
  };

  Contract.deployed = function() {
    if (!this.address) {
      throw new Error("Cannot find deployed address: PriceFeed not deployed or address not set.");
    }

    return this.at(this.address);
  };

  Contract.defaults = function(class_defaults) {
    if (this.class_defaults == null) {
      this.class_defaults = {};
    }

    if (class_defaults == null) {
      class_defaults = {};
    }

    var self = this;
    Object.keys(class_defaults).forEach(function(key) {
      var value = class_defaults[key];
      self.class_defaults[key] = value;
    });

    return this.class_defaults;
  };

  Contract.extend = function() {
    var args = Array.prototype.slice.call(arguments);

    for (var i = 0; i < arguments.length; i++) {
      var object = arguments[i];
      var keys = Object.keys(object);
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j];
        var value = object[key];
        this.prototype[key] = value;
      }
    }
  };

  Contract.all_networks = {
  "3": {
    "abi": [
      {
        "constant": true,
        "inputs": [
          {
            "name": "ofAsset",
            "type": "address"
          }
        ],
        "name": "getPrice",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "getLastUpdate",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "newFee",
            "type": "uint256"
          }
        ],
        "name": "setFee",
        "outputs": [
          {
            "name": "fee",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "owner",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "lastUpdate",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [],
        "name": "payOut",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "ofAssets",
            "type": "address[]"
          },
          {
            "name": "newPrices",
            "type": "uint256[]"
          }
        ],
        "name": "setPrice",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "fee",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "inputs": [],
        "payable": false,
        "type": "constructor"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "ofAsset",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "ofPrice",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "updateCounter",
            "type": "uint256"
          }
        ],
        "name": "PriceSet",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "sender",
            "type": "address"
          },
          {
            "indexed": true,
            "name": "ofAsset",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "updateCounter",
            "type": "uint256"
          }
        ],
        "name": "PriceRequested",
        "type": "event"
      }
    ],
    "unlinked_binary": "0x60606040526000600155600060025534610000575b5b60008054600160a060020a03191633600160a060020a03161790555b5b5b610488806100426000396000f300606060405236156100725763ffffffff60e060020a60003504166341976e0981146100775780634c89867f146100a257806369fe0e2d146100c15780638da5cb5b146100e3578063c04637111461010c578063c20524031461012b578063d441987d1461013a578063ddca3f43146101c4575b610000565b3461000057610090600160a060020a03600435166101e3565b60408051918252519081900360200190f35b3461000057610090610264565b60408051918252519081900360200190f35b346100005761009060043561026b565b60408051918252519081900360200190f35b34610000576100f0610290565b60408051600160a060020a039092168252519081900360200190f35b346100005761009061029f565b60408051918252519081900360200190f35b34610000576101386102a5565b005b3461000057610138600480803590602001908201803590602001908080602002602001604051908101604052809392919081815260200183836020028082843750506040805187358901803560208181028481018201909552818452989a9989019892975090820195509350839250850190849080828437509496506102f695505050505050565b005b3461000057610090610446565b60408051918252519081900360200190f35b60006002546101f48134101561044c565b82600160a060020a031633600160a060020a03167f5d3868f8264959a79aa810a4c9a3747e87b2f85ba41d223e1cfb18e1ae754c816001546040518082815260200191505060405180910390a3600160a060020a03831660009081526004602052604090205491505b5b50919050565b6003545b90565b6000805433600160a060020a0390811691161461028757610000565b50805b5b919050565b600054600160a060020a031681565b60035481565b60005433600160a060020a039081169116146102c057610000565b6040516102f290600160a060020a0333811691309091163180156108fc02916000818181858888f1935050505061044c565b5b5b565b6000805433600160a060020a0390811691161461031257610000565b8282610321815183511461044c565b42600355600092505b845183101561043c5783838151811015610000579060200190602002015160046000878681518110156100005790602001906020020151600160a060020a0316600160a060020a0316815260200190815260200160002081905550426005600087868151811015610000576020908102909101810151600160a060020a031682528101919091526040016000205560018054810190558451859084908110156100005790602001906020020151600160a060020a03167fd9359f6744c286382115ed720fc5e2e5da40d7aa33113ed0f1a3a4557c87ae4085858151811015610000576020908102909101810151600154604080519283529282015281519081900390910190a25b82600101925061032a565b5b5b50505b505050565b60025481565b80151561045857610000565b5b505600a165627a7a723058204469cc2ed7b6bc70cbce5af67df3a1ff772a18a5d63ffafd6d1137079d1110b20029",
    "events": {
      "0xd9359f6744c286382115ed720fc5e2e5da40d7aa33113ed0f1a3a4557c87ae40": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "ofAsset",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "ofPrice",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "updateCounter",
            "type": "uint256"
          }
        ],
        "name": "PriceSet",
        "type": "event"
      },
      "0x5d3868f8264959a79aa810a4c9a3747e87b2f85ba41d223e1cfb18e1ae754c81": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "sender",
            "type": "address"
          },
          {
            "indexed": true,
            "name": "ofAsset",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "updateCounter",
            "type": "uint256"
          }
        ],
        "name": "PriceRequested",
        "type": "event"
      }
    },
    "updated_at": 1485739921755,
    "links": {},
    "address": "0xb44e7ad93d15e8230a264e6e74e5de56d640058d"
  },
  "default": {
    "abi": [
      {
        "constant": true,
        "inputs": [
          {
            "name": "ofAsset",
            "type": "address"
          }
        ],
        "name": "getPrice",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "getLastUpdate",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "newFee",
            "type": "uint256"
          }
        ],
        "name": "setFee",
        "outputs": [
          {
            "name": "fee",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "owner",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "lastUpdate",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [],
        "name": "payOut",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "ofAssets",
            "type": "address[]"
          },
          {
            "name": "newPrices",
            "type": "uint256[]"
          }
        ],
        "name": "setPrice",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "fee",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "inputs": [],
        "payable": false,
        "type": "constructor"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "ofAsset",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "ofPrice",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "updateCounter",
            "type": "uint256"
          }
        ],
        "name": "PriceSet",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "sender",
            "type": "address"
          },
          {
            "indexed": true,
            "name": "ofAsset",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "updateCounter",
            "type": "uint256"
          }
        ],
        "name": "PriceRequested",
        "type": "event"
      }
    ],
    "unlinked_binary": "0x60606040526000600155600060025534610000575b5b60008054600160a060020a03191633600160a060020a03161790555b5b5b610488806100426000396000f300606060405236156100725763ffffffff60e060020a60003504166341976e0981146100775780634c89867f146100a257806369fe0e2d146100c15780638da5cb5b146100e3578063c04637111461010c578063c20524031461012b578063d441987d1461013a578063ddca3f43146101c4575b610000565b3461000057610090600160a060020a03600435166101e3565b60408051918252519081900360200190f35b3461000057610090610264565b60408051918252519081900360200190f35b346100005761009060043561026b565b60408051918252519081900360200190f35b34610000576100f0610290565b60408051600160a060020a039092168252519081900360200190f35b346100005761009061029f565b60408051918252519081900360200190f35b34610000576101386102a5565b005b3461000057610138600480803590602001908201803590602001908080602002602001604051908101604052809392919081815260200183836020028082843750506040805187358901803560208181028481018201909552818452989a9989019892975090820195509350839250850190849080828437509496506102f695505050505050565b005b3461000057610090610446565b60408051918252519081900360200190f35b60006002546101f48134101561044c565b82600160a060020a031633600160a060020a03167f5d3868f8264959a79aa810a4c9a3747e87b2f85ba41d223e1cfb18e1ae754c816001546040518082815260200191505060405180910390a3600160a060020a03831660009081526004602052604090205491505b5b50919050565b6003545b90565b6000805433600160a060020a0390811691161461028757610000565b50805b5b919050565b600054600160a060020a031681565b60035481565b60005433600160a060020a039081169116146102c057610000565b6040516102f290600160a060020a0333811691309091163180156108fc02916000818181858888f1935050505061044c565b5b5b565b6000805433600160a060020a0390811691161461031257610000565b8282610321815183511461044c565b42600355600092505b845183101561043c5783838151811015610000579060200190602002015160046000878681518110156100005790602001906020020151600160a060020a0316600160a060020a0316815260200190815260200160002081905550426005600087868151811015610000576020908102909101810151600160a060020a031682528101919091526040016000205560018054810190558451859084908110156100005790602001906020020151600160a060020a03167fd9359f6744c286382115ed720fc5e2e5da40d7aa33113ed0f1a3a4557c87ae4085858151811015610000576020908102909101810151600154604080519283529282015281519081900390910190a25b82600101925061032a565b5b5b50505b505050565b60025481565b80151561045857610000565b5b505600a165627a7a723058204469cc2ed7b6bc70cbce5af67df3a1ff772a18a5d63ffafd6d1137079d1110b20029",
    "events": {
      "0xd9359f6744c286382115ed720fc5e2e5da40d7aa33113ed0f1a3a4557c87ae40": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "ofAsset",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "ofPrice",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "updateCounter",
            "type": "uint256"
          }
        ],
        "name": "PriceSet",
        "type": "event"
      },
      "0x5d3868f8264959a79aa810a4c9a3747e87b2f85ba41d223e1cfb18e1ae754c81": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "sender",
            "type": "address"
          },
          {
            "indexed": true,
            "name": "ofAsset",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "updateCounter",
            "type": "uint256"
          }
        ],
        "name": "PriceRequested",
        "type": "event"
      }
    },
    "updated_at": 1485739475867
  }
};

  Contract.checkNetwork = function(callback) {
    var self = this;

    if (this.network_id != null) {
      return callback();
    }

    this.web3.version.network(function(err, result) {
      if (err) return callback(err);

      var network_id = result.toString();

      // If we have the main network,
      if (network_id == "1") {
        var possible_ids = ["1", "live", "default"];

        for (var i = 0; i < possible_ids.length; i++) {
          var id = possible_ids[i];
          if (Contract.all_networks[id] != null) {
            network_id = id;
            break;
          }
        }
      }

      if (self.all_networks[network_id] == null) {
        return callback(new Error(self.name + " error: Can't find artifacts for network id '" + network_id + "'"));
      }

      self.setNetwork(network_id);
      callback();
    })
  };

  Contract.setNetwork = function(network_id) {
    var network = this.all_networks[network_id] || {};

    this.abi             = this.prototype.abi             = network.abi;
    this.unlinked_binary = this.prototype.unlinked_binary = network.unlinked_binary;
    this.address         = this.prototype.address         = network.address;
    this.updated_at      = this.prototype.updated_at      = network.updated_at;
    this.links           = this.prototype.links           = network.links || {};
    this.events          = this.prototype.events          = network.events || {};

    this.network_id = network_id;
  };

  Contract.networks = function() {
    return Object.keys(this.all_networks);
  };

  Contract.link = function(name, address) {
    if (typeof name == "function") {
      var contract = name;

      if (contract.address == null) {
        throw new Error("Cannot link contract without an address.");
      }

      Contract.link(contract.contract_name, contract.address);

      // Merge events so this contract knows about library's events
      Object.keys(contract.events).forEach(function(topic) {
        Contract.events[topic] = contract.events[topic];
      });

      return;
    }

    if (typeof name == "object") {
      var obj = name;
      Object.keys(obj).forEach(function(name) {
        var a = obj[name];
        Contract.link(name, a);
      });
      return;
    }

    Contract.links[name] = address;
  };

  Contract.contract_name   = Contract.prototype.contract_name   = "PriceFeed";
  Contract.generated_with  = Contract.prototype.generated_with  = "3.2.0";

  // Allow people to opt-in to breaking changes now.
  Contract.next_gen = false;

  var properties = {
    binary: function() {
      var binary = Contract.unlinked_binary;

      Object.keys(Contract.links).forEach(function(library_name) {
        var library_address = Contract.links[library_name];
        var regex = new RegExp("__" + library_name + "_*", "g");

        binary = binary.replace(regex, library_address.replace("0x", ""));
      });

      return binary;
    }
  };

  Object.keys(properties).forEach(function(key) {
    var getter = properties[key];

    var definition = {};
    definition.enumerable = true;
    definition.configurable = false;
    definition.get = getter;

    Object.defineProperty(Contract, key, definition);
    Object.defineProperty(Contract.prototype, key, definition);
  });

  bootstrap(Contract);

  if (typeof module != "undefined" && typeof module.exports != "undefined") {
    module.exports = Contract;
  } else {
    // There will only be one version of this contract in the browser,
    // and we can use that.
    window.PriceFeed = Contract;
  }
})();
