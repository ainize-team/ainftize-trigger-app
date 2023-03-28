const Ain = require("@ainblockchain/ain-js").default;
const ain = new Ain("https://testnet-api.ainetwork.ai", 0);

require("dotenv").config();
const { PRIVATE_KEY } = process.env;

const ainCreateApp = async (appName) => {
  const private_key = PRIVATE_KEY;
  const myAddress = ain.wallet.addAndSetDefaultAccount(private_key);

  const res = await ain.db.ref(`/apps/${appName}/create/${Date.now()}`).setValue({
    value: {
      admin: {
        [myAddress]: true,
      },
      service: {
        staking: {
          lockup_duration: 604800000, 
        },
      },
    },
    nonce: -1,
  });

  // console.log(`res: ${JSON.stringify(res)}`);
  if (res) {
    console.log(res);
    console.log(`App Created with app name "${appName}"\nCheck TX in testnet-insight.ainetwork.ai: ${res.tx_hash}`);
  }
};

module.exports = { ainCreateApp: ainCreateApp };
