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
      throw new Error("Core error: Please call setProvider() first before calling new().");
    }

    var args = Array.prototype.slice.call(arguments);

    if (!this.unlinked_binary) {
      throw new Error("Core error: contract binary not set. Can't deploy new instance.");
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

      throw new Error("Core contains unresolved libraries. You must deploy and link the following libraries before you can deploy a new version of Core: " + unlinked_libraries);
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
      throw new Error("Invalid address passed to Core.at(): " + address);
    }

    var contract_class = this.web3.eth.contract(this.abi);
    var contract = contract_class.at(address);

    return new this(contract);
  };

  Contract.deployed = function() {
    if (!this.address) {
      throw new Error("Cannot find deployed address: Core not deployed or address not set.");
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
        "name": "name",
        "outputs": [
          {
            "name": "",
            "type": "string"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_spender",
            "type": "address"
          },
          {
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "approve",
        "outputs": [
          {
            "name": "success",
            "type": "bool"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "onExchange",
            "type": "address"
          },
          {
            "name": "sell_how_much",
            "type": "uint256"
          },
          {
            "name": "sell_which_token",
            "type": "address"
          },
          {
            "name": "buy_how_much",
            "type": "uint256"
          },
          {
            "name": "buy_which_token",
            "type": "address"
          }
        ],
        "name": "offer",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "wantedShares",
            "type": "uint256"
          }
        ],
        "name": "createShares",
        "outputs": [],
        "payable": true,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "totalSupply",
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
            "name": "_from",
            "type": "address"
          },
          {
            "name": "_to",
            "type": "address"
          },
          {
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "transferFrom",
        "outputs": [
          {
            "name": "success",
            "type": "bool"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "calcNAV",
        "outputs": [
          {
            "name": "nav",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "PRICE_OF_ETHER_RELATIVE_TO_REFERENCE_ASSET",
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
            "name": "_owner",
            "type": "address"
          }
        ],
        "name": "balanceOf",
        "outputs": [
          {
            "name": "balance",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "BASE_UNIT_OF_SHARES",
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
        "name": "sharePrice",
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
        "name": "calcSharePrice",
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
        "name": "symbol",
        "outputs": [
          {
            "name": "",
            "type": "string"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "onExchange",
            "type": "address"
          },
          {
            "name": "id",
            "type": "uint256"
          }
        ],
        "name": "cancel",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "offeredShares",
            "type": "uint256"
          },
          {
            "name": "wantedValue",
            "type": "uint256"
          }
        ],
        "name": "annihilateShares",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "sumInvested",
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
            "name": "onExchange",
            "type": "address"
          },
          {
            "name": "id",
            "type": "uint256"
          },
          {
            "name": "quantity",
            "type": "uint256"
          }
        ],
        "name": "buy",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_to",
            "type": "address"
          },
          {
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "transfer",
        "outputs": [
          {
            "name": "success",
            "type": "bool"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "calcGAV",
        "outputs": [
          {
            "name": "gav",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "precision",
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
        "name": "getRegistrarAddress",
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
        "name": "calcDelta",
        "outputs": [
          {
            "name": "delta",
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
            "name": "_owner",
            "type": "address"
          },
          {
            "name": "_spender",
            "type": "address"
          }
        ],
        "name": "allowance",
        "outputs": [
          {
            "name": "remaining",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "sumWithdrawn",
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
        "name": "REFERENCE_ASSET_INDEX_IN_REGISTRAR",
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
            "name": "ofManager",
            "type": "address"
          },
          {
            "name": "ofRegistrar",
            "type": "address"
          },
          {
            "name": "ofTrading",
            "type": "address"
          },
          {
            "name": "ofManagmentFee",
            "type": "address"
          },
          {
            "name": "ofPerformanceFee",
            "type": "address"
          }
        ],
        "payable": false,
        "type": "constructor"
      },
      {
        "payable": true,
        "type": "fallback"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "buyer",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "numShares",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "sharePrice",
            "type": "uint256"
          }
        ],
        "name": "SharesCreated",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "seller",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "numShares",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "sharePrice",
            "type": "uint256"
          }
        ],
        "name": "SharesAnnihilated",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "to",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "value",
            "type": "uint256"
          }
        ],
        "name": "Refund",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "_from",
            "type": "address"
          },
          {
            "indexed": true,
            "name": "_to",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "Transfer",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "_owner",
            "type": "address"
          },
          {
            "indexed": true,
            "name": "_spender",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "Approval",
        "type": "event"
      }
    ],
    "unlinked_binary": "0x6060604052670de0b6b3a7640000600f55346100005760405160a08061192b83398101604090815281516020830151918301516060840151608090940151919390915b5b60038054600160a060020a03191633600160a060020a03161790555b60038054600160a060020a03808816600160a060020a03199283161790925560006004818155670de0b6b3a764000060055542600655600880548986169416939093179283905560408051602090810184905281517faa9239f50000000000000000000000000000000000000000000000000000000081529283018490529051939094169363aa9239f59360248084019492939192918390030190829087803b156100005760325a03f1156100005750506040515160078054600160a060020a0319908116600160a060020a0393841617909155600b80548216878416179055600980548216868416179055600a8054909116918416919091179055505b50505050505b6117b9806101726000396000f300606060405236156101385763ffffffff60e060020a60003504166306fdde038114610141578063095ea7b3146101ce5780630f1bd811146101fe578063123c047a1461022d57806318160ddd1461023a57806323b872dd146102595780633327570b1461028f57806335b6eeda146102ae57806370a08231146102cd57806381025dfe146102f857806387269729146103175780638da5cb5b146103365780639489fa841461035f57806395d89b411461037e57806398590ef91461040b578063a108785a14610429578063a442414f1461043e578063a59ac6dd1461045d578063a9059cbb1461047e578063b37011bf146104ae578063d3b5dc3b146104cd578063d5ab0980146104ec578063dcb9690c14610515578063dd62ed3e14610534578063e6e8a32714610565578063ff1130f114610584575b61013f5b5b565b005b346100005761014e6105a3565b604080516020808252835181830152835191928392908301918501908083838215610194575b80518252602083111561019457601f199092019160209182019101610174565b505050905090810190601f1680156101c05780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b34610000576101ea600160a060020a03600435166024356105da565b604080519115158252519081900360200190f35b346100005761013f600160a060020a03600435811690602435906044358116906064359060843516610645565b005b61013f600435610852565b005b3461000057610247610a5a565b60408051918252519081900360200190f35b34610000576101ea600160a060020a0360043581169060243516604435610a60565b604080519115158252519081900360200190f35b3461000057610247610b6d565b60408051918252519081900360200190f35b3461000057610247610b85565b60408051918252519081900360200190f35b3461000057610247600160a060020a0360043516610b8a565b60408051918252519081900360200190f35b3461000057610247610ba9565b60408051918252519081900360200190f35b3461000057610247610bb5565b60408051918252519081900360200190f35b3461000057610343610bbb565b60408051600160a060020a039092168252519081900360200190f35b3461000057610247610bca565b60408051918252519081900360200190f35b346100005761014e610bda565b604080516020808252835181830152835191928392908301918501908083838215610194575b80518252602083111561019457601f199092019160209182019101610174565b505050905090810190601f1680156101c05780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b346100005761013f600160a060020a0360043516602435610c11565b005b346100005761013f600435602435610c8a565b005b3461000057610247611013565b60408051918252519081900360200190f35b346100005761013f600160a060020a0360043516602435604435611019565b005b34610000576101ea600160a060020a036004351660243561112b565b604080519115158252519081900360200190f35b34610000576102476111ee565b60408051918252519081900360200190f35b3461000057610247611527565b60408051918252519081900360200190f35b346100005761034361152c565b60408051600160a060020a039092168252519081900360200190f35b346100005761024761153c565b60408051918252519081900360200190f35b3461000057610247600160a060020a03600435811690602435166115a1565b60408051918252519081900360200190f35b34610000576102476115ce565b60408051918252519081900360200190f35b34610000576102476115d4565b60408051918252519081900360200190f35b60408051808201909152600f81527f4d656c6f6e20506f7274666f6c696f0000000000000000000000000000000000602082015281565b600160a060020a03338116600081815260016020908152604080832094871680845294825280832086905580518681529051929493927f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925929181900390910190a35060015b92915050565b60035433600160a060020a0390811691161461066057610000565b6008546040805160006020918201819052825160e360020a631a42387b028152600160a060020a038089166004830152935188958b956106df9591169363d211c3d89360248082019492918390030190829087803b156100005760325a03f11561000057505060405151600160a060020a0384811691161490506115d9565b6008546040805160006020918201819052825160e060020a63ab3a7425028152600160a060020a038a81166004830152935161074e95949094169363ab3a74259360248084019491938390030190829087803b156100005760325a03f1156100005750506040515190506115d9565b6008546040805160006020918201819052825160e060020a63ab3a7425028152600160a060020a03888116600483015293516107bd95949094169363ab3a74259360248084019491938390030190829087803b156100005760325a03f1156100005750506040515190506115d9565b604080516000602091820181905282517ff09ea2a6000000000000000000000000000000000000000000000000000000008152600481018a9052600160a060020a0389811660248301526044820189905287811660648301529351938b169363f09ea2a69360848084019491938390030190829087803b156100005760325a03f115610000575050505b5b50505b5050505050565b60006000600060006108658134116115d9565b846108718115156115d9565b610879610bca565b600f819055349550670de0b6b3a76400009087020493508484116109cf576108a3600d54856115e9565b600d556004546108b390856115e9565b600490815560075460408051600060209182015281517fd0e30db0000000000000000000000000000000000000000000000000000000008152915161093694600160a060020a039094169363d0e30db0938a93818301939092909182900301818588803b156100005761235a5a03f1156100005750506040515191506115d99050565b600160a060020a03331660009081526020819052604090205461095990876115e9565b600160a060020a03331660009081526020819052604090205560025461097f90876115e9565b600255600f5460408051600160a060020a03331681526020810189905280820192909252517ff8495c533745eb3efa4d74ccdbbd0938e9d1e88add51cdc7db168a9f15a737369181900360600190a15b84841015610a4f576040518486039350610a0a90600160a060020a0333169085156108fc029086906000818181858888f193505050506115d9565b60408051600160a060020a03331681526020810185905281517fbb28353e4598c3b9199101a66e0989549b659a59a54d2c27fbb183f1932c8e6d929181900390910190a15b5b5b505b5050505050565b60025481565b600160a060020a038316600090815260208190526040812054829010801590610ab05750600160a060020a0380851660009081526001602090815260408083203390941683529290522054829010155b8015610ad55750600160a060020a038316600090815260208190526040902054828101115b15610b6157600160a060020a0380841660008181526020818152604080832080548801905588851680845281842080548990039055600183528184203390961684529482529182902080548790039055815186815291519293927fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9281900390910190a3506001610b65565b5060005b5b9392505050565b600080808080610b7b6111ee565b030392505b505090565b600181565b600160a060020a0381166000908152602081905260409020545b919050565b670de0b6b3a764000081565b600f5481565b600354600160a060020a031681565b6000610bd461153c565b90505b90565b60408051808201909152600581527f4d4c4e2d50000000000000000000000000000000000000000000000000000000602082015281565b60035433600160a060020a03908116911614610c2c57610000565b81600160a060020a03166340e58ee5826000604051602001526040518263ffffffff1660e060020a02815260040180828152602001915050602060405180830381600087803b156100005760325a03f115610000575050505b5b5050565b600060006000600060006000600088610cca816000600033600160a060020a0316600160a060020a031681526020019081526020016000205410156115d9565b89610cd68115156115d9565b610cde610bca565b600f819055670de0b6b3a7640000908c02049850898910610fb057600854604080516000602091820181905282517f0132d1600000000000000000000000000000000000000000000000000000000081529251600160a060020a0390941693630132d1609360048082019493918390030190829087803b156100005760325a03f11561000057505060405151985060009750505b87871015610ef8576008546040805160006020918201819052825160e060020a63aa9239f5028152600481018c90529251600160a060020a039094169363aa9239f59360248082019493918390030190829087803b156100005760325a03f1156100005750505060405180519050955085600160a060020a03166370a08231306000604051602001526040518263ffffffff1660e060020a0281526004018082600160a060020a0316600160a060020a03168152602001915050602060405180830381600087803b156100005760325a03f11561000057505060405151955050841515610e5e57610eec565b6002548b8602811561000057049350610eec86600160a060020a031663a9059cbb33876000604051602001526040518363ffffffff1660e060020a0281526004018083600160a060020a0316600160a060020a0316815260200182815260200192505050602060405180830381600087803b156100005760325a03f1156100005750506040515190506115d9565b5b866001019650610d72565b610f04600e548a6115e9565b600e55600454610f14908a611611565b600455600160a060020a033316600090815260208190526040902054610f3a908c611611565b600160a060020a033316600090815260208190526040902055600254610f60908c611611565b600255600f5460408051600160a060020a0333168152602081018e905280820192909252517f6d1ea56dcd6dcf937743a4f926190b72632e8d241b3939423c443d3ad1d309d49181900360600190a15b898911156110035760408051600160a060020a03331681528b8b036020820181905282519095507fbb28353e4598c3b9199101a66e0989549b659a59a54d2c27fbb183f1932c8e6d929181900390910190a15b5b5b505b50505050505050505050565b600d5481565b60035460009081908190819033600160a060020a0390811691161461103d57610000565b86600160a060020a0316634579268a876000604051608001526040518263ffffffff1660e060020a02815260040180828152602001915050608060405180830381600087803b156100005760325a03f115610000575050506040518051906020018051906020018051906020018051905093509350935093506110c0828261162a565b86600160a060020a031663d6febde887876000604051602001526040518363ffffffff1660e060020a0281526004018083815260200182815260200192505050602060405180830381600087803b156100005760325a03f115610000575050505b5b50505050505050565b600160a060020a03331660009081526020819052604081205482901080159061116d5750600160a060020a038316600090815260208190526040902054828101115b156111df57600160a060020a0333811660008181526020818152604080832080548890039055938716808352918490208054870190558351868152935191937fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef929081900390910190a350600161063f565b50600061063f565b5b92915050565b60006000600060006000600060006000600760010160009054906101000a9004600160a060020a0316600160a060020a0316630132d1606000604051602001526040518163ffffffff1660e060020a028152600401809050602060405180830381600087803b156100005760325a03f11561000057505060405151975060009650505b8686101561151c576008546040805160006020918201819052825160e060020a63aa9239f5028152600481018b90529251600160a060020a039094169363aa9239f59360248082019493918390030190829087803b156100005760325a03f1156100005750505060405180519050945084600160a060020a03166370a08231306000604051602001526040518263ffffffff1660e060020a0281526004018082600160a060020a0316600160a060020a03168152602001915050602060405180830381600087803b156100005760325a03f1156100005750505060405180519050935084600160a060020a0316639670c0bc6000604051602001526040518163ffffffff1660e060020a028152600401809050602060405180830381600087803b156100005760325a03f1156100005750506040805180516008546000602093840181905284517f6532aad9000000000000000000000000000000000000000000000000000000008152600481018d90529451929850600160a060020a039091169450636532aad9936024808201949392918390030190829087803b156100005760325a03f11561000057505060408051805160085460006020938401819052845160e060020a63aa9239f5028152600481018d90529451929750600160a060020a0380891696506341976e099592169363aa9239f593602480850194929391928390030190829087803b156100005760325a03f11561000057505050604051805190506000604051602001526040518263ffffffff1660e060020a0281526004018082600160a060020a0316600160a060020a03168152602001915050602060405180830381600087803b156100005760325a03f11561000057505060405151915061150e905088600a85900a868402811561000057046115e9565b97505b856001019550611271565b5b5050505050505090565b601281565b600854600160a060020a03165b90565b60006000611548610b6d565b600454909150151561156457670de0b6b3a7640000915061158d565b80151561157b57670de0b6b3a7640000915061158d565b60045460055482028115610000570491505b5b60058290556004819055426006555b5090565b600160a060020a038083166000908152600160209081526040808320938516835292905220545b92915050565b600e5481565b600081565b8015156115e557610000565b5b50565b60008282016116068482108015906116015750838210155b6115d9565b8091505b5092915050565b600061161f838311156115d9565b508082035b92915050565b60035433600160a060020a0390811691161461164557610000565b6008546040805160006020918201819052825160e060020a63ab3a7425028152600160a060020a03868116600483015293516116b495949094169363ab3a74259360248084019491938390030190829087803b156100005760325a03f1156100005750506040515190506115d9565b6008546040805160006020918201819052825160e360020a631a42387b028152600160a060020a03808716600483018190529451949563095ea7b39591169363d211c3d8936024808501949293928390030190829087803b156100005760325a03f1156100005750505060405180519050846000604051602001526040518363ffffffff1660e060020a0281526004018083600160a060020a0316600160a060020a0316815260200182815260200192505050602060405180830381600087803b156100005760325a03f115610000575050505b5b50505600a165627a7a72305820d58240e14184a856fb556923b38d1c379f0c0de3dae5c663807b09f17c9f7dfe0029",
    "events": {
      "0xf8495c533745eb3efa4d74ccdbbd0938e9d1e88add51cdc7db168a9f15a73736": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "buyer",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "numShares",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "sharePrice",
            "type": "uint256"
          }
        ],
        "name": "SharesCreated",
        "type": "event"
      },
      "0x6d1ea56dcd6dcf937743a4f926190b72632e8d241b3939423c443d3ad1d309d4": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "seller",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "numShares",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "sharePrice",
            "type": "uint256"
          }
        ],
        "name": "SharesAnnihilated",
        "type": "event"
      },
      "0xbb28353e4598c3b9199101a66e0989549b659a59a54d2c27fbb183f1932c8e6d": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "to",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "value",
            "type": "uint256"
          }
        ],
        "name": "Refund",
        "type": "event"
      },
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "_from",
            "type": "address"
          },
          {
            "indexed": true,
            "name": "_to",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "Transfer",
        "type": "event"
      },
      "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "_owner",
            "type": "address"
          },
          {
            "indexed": true,
            "name": "_spender",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "Approval",
        "type": "event"
      }
    },
    "updated_at": 1485739921693,
    "links": {}
  },
  "default": {
    "abi": [
      {
        "constant": true,
        "inputs": [],
        "name": "name",
        "outputs": [
          {
            "name": "",
            "type": "string"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_spender",
            "type": "address"
          },
          {
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "approve",
        "outputs": [
          {
            "name": "success",
            "type": "bool"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "onExchange",
            "type": "address"
          },
          {
            "name": "sell_how_much",
            "type": "uint256"
          },
          {
            "name": "sell_which_token",
            "type": "address"
          },
          {
            "name": "buy_how_much",
            "type": "uint256"
          },
          {
            "name": "buy_which_token",
            "type": "address"
          }
        ],
        "name": "offer",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "wantedShares",
            "type": "uint256"
          }
        ],
        "name": "createShares",
        "outputs": [],
        "payable": true,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "totalSupply",
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
            "name": "_from",
            "type": "address"
          },
          {
            "name": "_to",
            "type": "address"
          },
          {
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "transferFrom",
        "outputs": [
          {
            "name": "success",
            "type": "bool"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "calcNAV",
        "outputs": [
          {
            "name": "nav",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "PRICE_OF_ETHER_RELATIVE_TO_REFERENCE_ASSET",
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
            "name": "_owner",
            "type": "address"
          }
        ],
        "name": "balanceOf",
        "outputs": [
          {
            "name": "balance",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "BASE_UNIT_OF_SHARES",
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
        "name": "sharePrice",
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
        "name": "calcSharePrice",
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
        "name": "symbol",
        "outputs": [
          {
            "name": "",
            "type": "string"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "onExchange",
            "type": "address"
          },
          {
            "name": "id",
            "type": "uint256"
          }
        ],
        "name": "cancel",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "offeredShares",
            "type": "uint256"
          },
          {
            "name": "wantedValue",
            "type": "uint256"
          }
        ],
        "name": "annihilateShares",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "sumInvested",
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
            "name": "onExchange",
            "type": "address"
          },
          {
            "name": "id",
            "type": "uint256"
          },
          {
            "name": "quantity",
            "type": "uint256"
          }
        ],
        "name": "buy",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_to",
            "type": "address"
          },
          {
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "transfer",
        "outputs": [
          {
            "name": "success",
            "type": "bool"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "calcGAV",
        "outputs": [
          {
            "name": "gav",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "precision",
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
        "name": "getRegistrarAddress",
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
        "name": "calcDelta",
        "outputs": [
          {
            "name": "delta",
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
            "name": "_owner",
            "type": "address"
          },
          {
            "name": "_spender",
            "type": "address"
          }
        ],
        "name": "allowance",
        "outputs": [
          {
            "name": "remaining",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "sumWithdrawn",
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
        "name": "REFERENCE_ASSET_INDEX_IN_REGISTRAR",
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
            "name": "ofManager",
            "type": "address"
          },
          {
            "name": "ofRegistrar",
            "type": "address"
          },
          {
            "name": "ofTrading",
            "type": "address"
          },
          {
            "name": "ofManagmentFee",
            "type": "address"
          },
          {
            "name": "ofPerformanceFee",
            "type": "address"
          }
        ],
        "payable": false,
        "type": "constructor"
      },
      {
        "payable": true,
        "type": "fallback"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "buyer",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "numShares",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "sharePrice",
            "type": "uint256"
          }
        ],
        "name": "SharesCreated",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "seller",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "numShares",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "sharePrice",
            "type": "uint256"
          }
        ],
        "name": "SharesAnnihilated",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "to",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "value",
            "type": "uint256"
          }
        ],
        "name": "Refund",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "_from",
            "type": "address"
          },
          {
            "indexed": true,
            "name": "_to",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "Transfer",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "_owner",
            "type": "address"
          },
          {
            "indexed": true,
            "name": "_spender",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "Approval",
        "type": "event"
      }
    ],
    "unlinked_binary": "0x6060604052670de0b6b3a7640000600f55346100005760405160a08061192b83398101604090815281516020830151918301516060840151608090940151919390915b5b60038054600160a060020a03191633600160a060020a03161790555b60038054600160a060020a03808816600160a060020a03199283161790925560006004818155670de0b6b3a764000060055542600655600880548986169416939093179283905560408051602090810184905281517faa9239f50000000000000000000000000000000000000000000000000000000081529283018490529051939094169363aa9239f59360248084019492939192918390030190829087803b156100005760325a03f1156100005750506040515160078054600160a060020a0319908116600160a060020a0393841617909155600b80548216878416179055600980548216868416179055600a8054909116918416919091179055505b50505050505b6117b9806101726000396000f300606060405236156101385763ffffffff60e060020a60003504166306fdde038114610141578063095ea7b3146101ce5780630f1bd811146101fe578063123c047a1461022d57806318160ddd1461023a57806323b872dd146102595780633327570b1461028f57806335b6eeda146102ae57806370a08231146102cd57806381025dfe146102f857806387269729146103175780638da5cb5b146103365780639489fa841461035f57806395d89b411461037e57806398590ef91461040b578063a108785a14610429578063a442414f1461043e578063a59ac6dd1461045d578063a9059cbb1461047e578063b37011bf146104ae578063d3b5dc3b146104cd578063d5ab0980146104ec578063dcb9690c14610515578063dd62ed3e14610534578063e6e8a32714610565578063ff1130f114610584575b61013f5b5b565b005b346100005761014e6105a3565b604080516020808252835181830152835191928392908301918501908083838215610194575b80518252602083111561019457601f199092019160209182019101610174565b505050905090810190601f1680156101c05780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b34610000576101ea600160a060020a03600435166024356105da565b604080519115158252519081900360200190f35b346100005761013f600160a060020a03600435811690602435906044358116906064359060843516610645565b005b61013f600435610852565b005b3461000057610247610a5a565b60408051918252519081900360200190f35b34610000576101ea600160a060020a0360043581169060243516604435610a60565b604080519115158252519081900360200190f35b3461000057610247610b6d565b60408051918252519081900360200190f35b3461000057610247610b85565b60408051918252519081900360200190f35b3461000057610247600160a060020a0360043516610b8a565b60408051918252519081900360200190f35b3461000057610247610ba9565b60408051918252519081900360200190f35b3461000057610247610bb5565b60408051918252519081900360200190f35b3461000057610343610bbb565b60408051600160a060020a039092168252519081900360200190f35b3461000057610247610bca565b60408051918252519081900360200190f35b346100005761014e610bda565b604080516020808252835181830152835191928392908301918501908083838215610194575b80518252602083111561019457601f199092019160209182019101610174565b505050905090810190601f1680156101c05780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b346100005761013f600160a060020a0360043516602435610c11565b005b346100005761013f600435602435610c8a565b005b3461000057610247611013565b60408051918252519081900360200190f35b346100005761013f600160a060020a0360043516602435604435611019565b005b34610000576101ea600160a060020a036004351660243561112b565b604080519115158252519081900360200190f35b34610000576102476111ee565b60408051918252519081900360200190f35b3461000057610247611527565b60408051918252519081900360200190f35b346100005761034361152c565b60408051600160a060020a039092168252519081900360200190f35b346100005761024761153c565b60408051918252519081900360200190f35b3461000057610247600160a060020a03600435811690602435166115a1565b60408051918252519081900360200190f35b34610000576102476115ce565b60408051918252519081900360200190f35b34610000576102476115d4565b60408051918252519081900360200190f35b60408051808201909152600f81527f4d656c6f6e20506f7274666f6c696f0000000000000000000000000000000000602082015281565b600160a060020a03338116600081815260016020908152604080832094871680845294825280832086905580518681529051929493927f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925929181900390910190a35060015b92915050565b60035433600160a060020a0390811691161461066057610000565b6008546040805160006020918201819052825160e360020a631a42387b028152600160a060020a038089166004830152935188958b956106df9591169363d211c3d89360248082019492918390030190829087803b156100005760325a03f11561000057505060405151600160a060020a0384811691161490506115d9565b6008546040805160006020918201819052825160e060020a63ab3a7425028152600160a060020a038a81166004830152935161074e95949094169363ab3a74259360248084019491938390030190829087803b156100005760325a03f1156100005750506040515190506115d9565b6008546040805160006020918201819052825160e060020a63ab3a7425028152600160a060020a03888116600483015293516107bd95949094169363ab3a74259360248084019491938390030190829087803b156100005760325a03f1156100005750506040515190506115d9565b604080516000602091820181905282517ff09ea2a6000000000000000000000000000000000000000000000000000000008152600481018a9052600160a060020a0389811660248301526044820189905287811660648301529351938b169363f09ea2a69360848084019491938390030190829087803b156100005760325a03f115610000575050505b5b50505b5050505050565b60006000600060006108658134116115d9565b846108718115156115d9565b610879610bca565b600f819055349550670de0b6b3a76400009087020493508484116109cf576108a3600d54856115e9565b600d556004546108b390856115e9565b600490815560075460408051600060209182015281517fd0e30db0000000000000000000000000000000000000000000000000000000008152915161093694600160a060020a039094169363d0e30db0938a93818301939092909182900301818588803b156100005761235a5a03f1156100005750506040515191506115d99050565b600160a060020a03331660009081526020819052604090205461095990876115e9565b600160a060020a03331660009081526020819052604090205560025461097f90876115e9565b600255600f5460408051600160a060020a03331681526020810189905280820192909252517ff8495c533745eb3efa4d74ccdbbd0938e9d1e88add51cdc7db168a9f15a737369181900360600190a15b84841015610a4f576040518486039350610a0a90600160a060020a0333169085156108fc029086906000818181858888f193505050506115d9565b60408051600160a060020a03331681526020810185905281517fbb28353e4598c3b9199101a66e0989549b659a59a54d2c27fbb183f1932c8e6d929181900390910190a15b5b5b505b5050505050565b60025481565b600160a060020a038316600090815260208190526040812054829010801590610ab05750600160a060020a0380851660009081526001602090815260408083203390941683529290522054829010155b8015610ad55750600160a060020a038316600090815260208190526040902054828101115b15610b6157600160a060020a0380841660008181526020818152604080832080548801905588851680845281842080548990039055600183528184203390961684529482529182902080548790039055815186815291519293927fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9281900390910190a3506001610b65565b5060005b5b9392505050565b600080808080610b7b6111ee565b030392505b505090565b600181565b600160a060020a0381166000908152602081905260409020545b919050565b670de0b6b3a764000081565b600f5481565b600354600160a060020a031681565b6000610bd461153c565b90505b90565b60408051808201909152600581527f4d4c4e2d50000000000000000000000000000000000000000000000000000000602082015281565b60035433600160a060020a03908116911614610c2c57610000565b81600160a060020a03166340e58ee5826000604051602001526040518263ffffffff1660e060020a02815260040180828152602001915050602060405180830381600087803b156100005760325a03f115610000575050505b5b5050565b600060006000600060006000600088610cca816000600033600160a060020a0316600160a060020a031681526020019081526020016000205410156115d9565b89610cd68115156115d9565b610cde610bca565b600f819055670de0b6b3a7640000908c02049850898910610fb057600854604080516000602091820181905282517f0132d1600000000000000000000000000000000000000000000000000000000081529251600160a060020a0390941693630132d1609360048082019493918390030190829087803b156100005760325a03f11561000057505060405151985060009750505b87871015610ef8576008546040805160006020918201819052825160e060020a63aa9239f5028152600481018c90529251600160a060020a039094169363aa9239f59360248082019493918390030190829087803b156100005760325a03f1156100005750505060405180519050955085600160a060020a03166370a08231306000604051602001526040518263ffffffff1660e060020a0281526004018082600160a060020a0316600160a060020a03168152602001915050602060405180830381600087803b156100005760325a03f11561000057505060405151955050841515610e5e57610eec565b6002548b8602811561000057049350610eec86600160a060020a031663a9059cbb33876000604051602001526040518363ffffffff1660e060020a0281526004018083600160a060020a0316600160a060020a0316815260200182815260200192505050602060405180830381600087803b156100005760325a03f1156100005750506040515190506115d9565b5b866001019650610d72565b610f04600e548a6115e9565b600e55600454610f14908a611611565b600455600160a060020a033316600090815260208190526040902054610f3a908c611611565b600160a060020a033316600090815260208190526040902055600254610f60908c611611565b600255600f5460408051600160a060020a0333168152602081018e905280820192909252517f6d1ea56dcd6dcf937743a4f926190b72632e8d241b3939423c443d3ad1d309d49181900360600190a15b898911156110035760408051600160a060020a03331681528b8b036020820181905282519095507fbb28353e4598c3b9199101a66e0989549b659a59a54d2c27fbb183f1932c8e6d929181900390910190a15b5b5b505b50505050505050505050565b600d5481565b60035460009081908190819033600160a060020a0390811691161461103d57610000565b86600160a060020a0316634579268a876000604051608001526040518263ffffffff1660e060020a02815260040180828152602001915050608060405180830381600087803b156100005760325a03f115610000575050506040518051906020018051906020018051906020018051905093509350935093506110c0828261162a565b86600160a060020a031663d6febde887876000604051602001526040518363ffffffff1660e060020a0281526004018083815260200182815260200192505050602060405180830381600087803b156100005760325a03f115610000575050505b5b50505050505050565b600160a060020a03331660009081526020819052604081205482901080159061116d5750600160a060020a038316600090815260208190526040902054828101115b156111df57600160a060020a0333811660008181526020818152604080832080548890039055938716808352918490208054870190558351868152935191937fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef929081900390910190a350600161063f565b50600061063f565b5b92915050565b60006000600060006000600060006000600760010160009054906101000a9004600160a060020a0316600160a060020a0316630132d1606000604051602001526040518163ffffffff1660e060020a028152600401809050602060405180830381600087803b156100005760325a03f11561000057505060405151975060009650505b8686101561151c576008546040805160006020918201819052825160e060020a63aa9239f5028152600481018b90529251600160a060020a039094169363aa9239f59360248082019493918390030190829087803b156100005760325a03f1156100005750505060405180519050945084600160a060020a03166370a08231306000604051602001526040518263ffffffff1660e060020a0281526004018082600160a060020a0316600160a060020a03168152602001915050602060405180830381600087803b156100005760325a03f1156100005750505060405180519050935084600160a060020a0316639670c0bc6000604051602001526040518163ffffffff1660e060020a028152600401809050602060405180830381600087803b156100005760325a03f1156100005750506040805180516008546000602093840181905284517f6532aad9000000000000000000000000000000000000000000000000000000008152600481018d90529451929850600160a060020a039091169450636532aad9936024808201949392918390030190829087803b156100005760325a03f11561000057505060408051805160085460006020938401819052845160e060020a63aa9239f5028152600481018d90529451929750600160a060020a0380891696506341976e099592169363aa9239f593602480850194929391928390030190829087803b156100005760325a03f11561000057505050604051805190506000604051602001526040518263ffffffff1660e060020a0281526004018082600160a060020a0316600160a060020a03168152602001915050602060405180830381600087803b156100005760325a03f11561000057505060405151915061150e905088600a85900a868402811561000057046115e9565b97505b856001019550611271565b5b5050505050505090565b601281565b600854600160a060020a03165b90565b60006000611548610b6d565b600454909150151561156457670de0b6b3a7640000915061158d565b80151561157b57670de0b6b3a7640000915061158d565b60045460055482028115610000570491505b5b60058290556004819055426006555b5090565b600160a060020a038083166000908152600160209081526040808320938516835292905220545b92915050565b600e5481565b600081565b8015156115e557610000565b5b50565b60008282016116068482108015906116015750838210155b6115d9565b8091505b5092915050565b600061161f838311156115d9565b508082035b92915050565b60035433600160a060020a0390811691161461164557610000565b6008546040805160006020918201819052825160e060020a63ab3a7425028152600160a060020a03868116600483015293516116b495949094169363ab3a74259360248084019491938390030190829087803b156100005760325a03f1156100005750506040515190506115d9565b6008546040805160006020918201819052825160e360020a631a42387b028152600160a060020a03808716600483018190529451949563095ea7b39591169363d211c3d8936024808501949293928390030190829087803b156100005760325a03f1156100005750505060405180519050846000604051602001526040518363ffffffff1660e060020a0281526004018083600160a060020a0316600160a060020a0316815260200182815260200192505050602060405180830381600087803b156100005760325a03f115610000575050505b5b50505600a165627a7a72305820d58240e14184a856fb556923b38d1c379f0c0de3dae5c663807b09f17c9f7dfe0029",
    "events": {
      "0xf8495c533745eb3efa4d74ccdbbd0938e9d1e88add51cdc7db168a9f15a73736": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "buyer",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "numShares",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "sharePrice",
            "type": "uint256"
          }
        ],
        "name": "SharesCreated",
        "type": "event"
      },
      "0x6d1ea56dcd6dcf937743a4f926190b72632e8d241b3939423c443d3ad1d309d4": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "seller",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "numShares",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "sharePrice",
            "type": "uint256"
          }
        ],
        "name": "SharesAnnihilated",
        "type": "event"
      },
      "0xbb28353e4598c3b9199101a66e0989549b659a59a54d2c27fbb183f1932c8e6d": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "to",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "value",
            "type": "uint256"
          }
        ],
        "name": "Refund",
        "type": "event"
      },
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "_from",
            "type": "address"
          },
          {
            "indexed": true,
            "name": "_to",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "Transfer",
        "type": "event"
      },
      "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "_owner",
            "type": "address"
          },
          {
            "indexed": true,
            "name": "_spender",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "_value",
            "type": "uint256"
          }
        ],
        "name": "Approval",
        "type": "event"
      }
    },
    "updated_at": 1485739475861
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

  Contract.contract_name   = Contract.prototype.contract_name   = "Core";
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
    window.Core = Contract;
  }
})();
