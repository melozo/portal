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
      throw new Error("Registrar error: Please call setProvider() first before calling new().");
    }

    var args = Array.prototype.slice.call(arguments);

    if (!this.unlinked_binary) {
      throw new Error("Registrar error: contract binary not set. Can't deploy new instance.");
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

      throw new Error("Registrar contains unresolved libraries. You must deploy and link the following libraries before you can deploy a new version of Registrar: " + unlinked_libraries);
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
      throw new Error("Invalid address passed to Registrar.at(): " + address);
    }

    var contract_class = this.web3.eth.contract(this.abi);
    var contract = contract_class.at(address);

    return new this(contract);
  };

  Contract.deployed = function() {
    if (!this.address) {
      throw new Error("Cannot find deployed address: Registrar not deployed or address not set.");
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
        "inputs": [],
        "name": "numAssignedAssets",
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
        "inputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "name": "priceFeeds",
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
        "inputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "name": "exchanges",
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
        "inputs": [
          {
            "name": "index",
            "type": "uint256"
          }
        ],
        "name": "exchangesAt",
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
        "inputs": [
          {
            "name": "index",
            "type": "uint256"
          }
        ],
        "name": "priceFeedsAt",
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
        "inputs": [
          {
            "name": "index",
            "type": "uint256"
          }
        ],
        "name": "assetAt",
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
        "inputs": [
          {
            "name": "ofAsset",
            "type": "address"
          }
        ],
        "name": "availability",
        "outputs": [
          {
            "name": "",
            "type": "bool"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "name": "assets",
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
        "inputs": [
          {
            "name": "ofAsset",
            "type": "address"
          }
        ],
        "name": "assignedExchange",
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
        "name": "ETHER_TOKEN_INDEX",
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
        "inputs": [
          {
            "name": "ofAssets",
            "type": "address[]"
          },
          {
            "name": "ofPriceFeeds",
            "type": "address[]"
          },
          {
            "name": "ofExchanges",
            "type": "address[]"
          }
        ],
        "payable": false,
        "type": "constructor"
      }
    ],
    "unlinked_binary": "0x6060604052346100005760405161078038038061078083398101604090815281516020830151918301519083019291820191015b60005b60008054600160a060020a03191633600160a060020a03161790555b83838361007c8251845114801561006a575081518351145b6401000000006103f961032c82021704565b8661009e60018251101561032c640100000000026103f9176401000000009004565b600094505b875185101561031c576001600460008a88815181101561000057602090810291909101810151600160a060020a03168252810191909152604001600020805460ff1916911515919091179055600180548082018083558281838015829011610130576000838152602090206101309181019083015b8082111561012c5760008155600101610118565b5090565b5b505050916000526020600020900160005b8a8881518110156100005790602001906020020151909190916101000a815481600160a060020a030219169083600160a060020a0316021790555050600280548060010182818154818355818115116101c0576000838152602090206101c09181019083015b8082111561012c5760008155600101610118565b5090565b5b505050916000526020600020900160005b898881518110156100005790602001906020020151909190916101000a815481600160a060020a030219169083600160a060020a031602179055505060038054806001018281815481835581811511610250576000838152602090206102509181019083015b8082111561012c5760008155600101610118565b5090565b5b505050916000526020600020900160005b888881518110156100005790602001906020020151909190916101000a815481600160a060020a030219169083600160a060020a0316021790555050858581518110156100005790602001906020020151600560008a8881518110156100005790602001906020020151600160a060020a0316600160a060020a0316815260200190815260200160002060006101000a815481600160a060020a030219169083600160a060020a031602179055505b8460010194506100a3565b5b5b505b5050505050505061033c565b80151561033857610000565b5b50565b6104358061034b6000396000f300606060405236156100935763ffffffff60e060020a6000350416630132d160811461009857806310c7f0b9146100b75780632839fc29146100e357806344271bff1461010f5780636532aad91461013b5780638da5cb5b14610167578063aa9239f514610190578063ab3a7425146101bc578063cf35bdd0146101e9578063d211c3d814610215578063d5611d431461024a575b610000565b34610000576100a5610269565b60408051918252519081900360200190f35b34610000576100c7600435610270565b60408051600160a060020a039092168252519081900360200190f35b34610000576100c76004356102a0565b60408051600160a060020a039092168252519081900360200190f35b34610000576100c76004356102d0565b60408051600160a060020a039092168252519081900360200190f35b34610000576100c7600435610306565b60408051600160a060020a039092168252519081900360200190f35b34610000576100c761033c565b60408051600160a060020a039092168252519081900360200190f35b34610000576100c760043561034b565b60408051600160a060020a039092168252519081900360200190f35b34610000576101d5600160a060020a0360043516610381565b604080519115158252519081900360200190f35b34610000576100c76004356103a3565b60408051600160a060020a039092168252519081900360200190f35b34610000576100c7600160a060020a03600435166103d3565b60408051600160a060020a039092168252519081900360200190f35b34610000576100a56103f4565b60408051918252519081900360200190f35b6001545b90565b600281815481101561000057906000526020600020900160005b915054906101000a9004600160a060020a031681565b600381815481101561000057906000526020600020900160005b915054906101000a9004600160a060020a031681565b6000600382815481101561000057906000526020600020900160005b9054906101000a9004600160a060020a031690505b919050565b6000600282815481101561000057906000526020600020900160005b9054906101000a9004600160a060020a031690505b919050565b600054600160a060020a031681565b6000600182815481101561000057906000526020600020900160005b9054906101000a9004600160a060020a031690505b919050565b600160a060020a03811660009081526004602052604090205460ff165b919050565b600181815481101561000057906000526020600020900160005b915054906101000a9004600160a060020a031681565b600160a060020a03808216600090815260056020526040902054165b919050565b600081565b80151561040557610000565b5b505600a165627a7a72305820fe7c5fede57c333618eeaf742b804c220af9df5af63a6415c5d2b9ef3472b9e20029",
    "events": {},
    "updated_at": 1485739921762,
    "links": {},
    "address": "0x919ac6883f2e693d376cad2c180a2e4f31e49b51"
  },
  "default": {
    "abi": [
      {
        "constant": true,
        "inputs": [],
        "name": "numAssignedAssets",
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
        "inputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "name": "priceFeeds",
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
        "inputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "name": "exchanges",
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
        "inputs": [
          {
            "name": "index",
            "type": "uint256"
          }
        ],
        "name": "exchangesAt",
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
        "inputs": [
          {
            "name": "index",
            "type": "uint256"
          }
        ],
        "name": "priceFeedsAt",
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
        "inputs": [
          {
            "name": "index",
            "type": "uint256"
          }
        ],
        "name": "assetAt",
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
        "inputs": [
          {
            "name": "ofAsset",
            "type": "address"
          }
        ],
        "name": "availability",
        "outputs": [
          {
            "name": "",
            "type": "bool"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "name": "assets",
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
        "inputs": [
          {
            "name": "ofAsset",
            "type": "address"
          }
        ],
        "name": "assignedExchange",
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
        "name": "ETHER_TOKEN_INDEX",
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
        "inputs": [
          {
            "name": "ofAssets",
            "type": "address[]"
          },
          {
            "name": "ofPriceFeeds",
            "type": "address[]"
          },
          {
            "name": "ofExchanges",
            "type": "address[]"
          }
        ],
        "payable": false,
        "type": "constructor"
      }
    ],
    "unlinked_binary": "0x6060604052346100005760405161078038038061078083398101604090815281516020830151918301519083019291820191015b60005b60008054600160a060020a03191633600160a060020a03161790555b83838361007c8251845114801561006a575081518351145b6401000000006103f961032c82021704565b8661009e60018251101561032c640100000000026103f9176401000000009004565b600094505b875185101561031c576001600460008a88815181101561000057602090810291909101810151600160a060020a03168252810191909152604001600020805460ff1916911515919091179055600180548082018083558281838015829011610130576000838152602090206101309181019083015b8082111561012c5760008155600101610118565b5090565b5b505050916000526020600020900160005b8a8881518110156100005790602001906020020151909190916101000a815481600160a060020a030219169083600160a060020a0316021790555050600280548060010182818154818355818115116101c0576000838152602090206101c09181019083015b8082111561012c5760008155600101610118565b5090565b5b505050916000526020600020900160005b898881518110156100005790602001906020020151909190916101000a815481600160a060020a030219169083600160a060020a031602179055505060038054806001018281815481835581811511610250576000838152602090206102509181019083015b8082111561012c5760008155600101610118565b5090565b5b505050916000526020600020900160005b888881518110156100005790602001906020020151909190916101000a815481600160a060020a030219169083600160a060020a0316021790555050858581518110156100005790602001906020020151600560008a8881518110156100005790602001906020020151600160a060020a0316600160a060020a0316815260200190815260200160002060006101000a815481600160a060020a030219169083600160a060020a031602179055505b8460010194506100a3565b5b5b505b5050505050505061033c565b80151561033857610000565b5b50565b6104358061034b6000396000f300606060405236156100935763ffffffff60e060020a6000350416630132d160811461009857806310c7f0b9146100b75780632839fc29146100e357806344271bff1461010f5780636532aad91461013b5780638da5cb5b14610167578063aa9239f514610190578063ab3a7425146101bc578063cf35bdd0146101e9578063d211c3d814610215578063d5611d431461024a575b610000565b34610000576100a5610269565b60408051918252519081900360200190f35b34610000576100c7600435610270565b60408051600160a060020a039092168252519081900360200190f35b34610000576100c76004356102a0565b60408051600160a060020a039092168252519081900360200190f35b34610000576100c76004356102d0565b60408051600160a060020a039092168252519081900360200190f35b34610000576100c7600435610306565b60408051600160a060020a039092168252519081900360200190f35b34610000576100c761033c565b60408051600160a060020a039092168252519081900360200190f35b34610000576100c760043561034b565b60408051600160a060020a039092168252519081900360200190f35b34610000576101d5600160a060020a0360043516610381565b604080519115158252519081900360200190f35b34610000576100c76004356103a3565b60408051600160a060020a039092168252519081900360200190f35b34610000576100c7600160a060020a03600435166103d3565b60408051600160a060020a039092168252519081900360200190f35b34610000576100a56103f4565b60408051918252519081900360200190f35b6001545b90565b600281815481101561000057906000526020600020900160005b915054906101000a9004600160a060020a031681565b600381815481101561000057906000526020600020900160005b915054906101000a9004600160a060020a031681565b6000600382815481101561000057906000526020600020900160005b9054906101000a9004600160a060020a031690505b919050565b6000600282815481101561000057906000526020600020900160005b9054906101000a9004600160a060020a031690505b919050565b600054600160a060020a031681565b6000600182815481101561000057906000526020600020900160005b9054906101000a9004600160a060020a031690505b919050565b600160a060020a03811660009081526004602052604090205460ff165b919050565b600181815481101561000057906000526020600020900160005b915054906101000a9004600160a060020a031681565b600160a060020a03808216600090815260056020526040902054165b919050565b600081565b80151561040557610000565b5b505600a165627a7a72305820fe7c5fede57c333618eeaf742b804c220af9df5af63a6415c5d2b9ef3472b9e20029",
    "events": {},
    "updated_at": 1485739475868
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

  Contract.contract_name   = Contract.prototype.contract_name   = "Registrar";
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
    window.Registrar = Contract;
  }
})();
