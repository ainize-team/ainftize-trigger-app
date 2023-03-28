const express = require('express');
const AinJs = require('@ainblockchain/ain-js').default;
const axios = require('axios');
const dotenv = require('dotenv');
const pinataSDK = require("@pinata/sdk");
const fs = require("fs");
const { Readable } = require("stream");
const NodeCache = require("node-cache");
dotenv.config();

const { parsePath, formatPath } = require('./util');

const app = express();

const port = 80;
const blockchainEndpoint = process.env.PROVIDER_URL;
const chainId = process.env.NETWORK === 'mainnet' ? 1 : 0;
const ain = new AinJs(blockchainEndpoint, chainId);
const BOT_PRIVKEY = process.env.AINIZE_INTERNAL_PRIVATE_KEY;
const BOT_ADDRESS = AinJs.utils.toChecksumAddress(ain.wallet.add(BOT_PRIVKEY));
const pinataApiKey = process.env.PINATA_API_KEY;
const pinataSecretApiKey = process.env.PINATA_SECRET_API_KEY;
const cache = new NodeCache();
// set BOT_ADDRESS as default wallet
ain.wallet.setDefaultAccount(BOT_ADDRESS);

app.use(express.json());

app.get('/', (req, res, next) => {
	res.status(200)
		.set('Content-Type', 'text/plain')
		.send(`SD inpainting trigger is alive!
               input path: /apps/ainftize_trigger_app/sd_inpainting/$user_addr/$tokenId/$timestamp/input
               verify path: /apps/ainftize_trigger_app/sd_inpainting/$user_addr/$tokenId/$timestamp/verify
               `)
		.end();
});

app.post('/trigger', async (req, res) => {

	const { transaction } = req.body;
	const value = transaction.tx_body.operation.value;
	const taskId = value.params.task_id;
	if(cache.get(taskId)){
		cache.ttl(taskId, 60);
		return;
	}

	// if request is first request, set cache 
	cache.set(taskId, true, 60);

	// for catch error
	let uploadMetadataRes; 
	let uploadImgRes;

	console.log(JSON.stringify(transaction));

	const inputPath = transaction.tx_body.operation.ref;
	const parsedInputPath = parsePath(inputPath);

	// pre-check the output path
	const rootPath = [...parsedInputPath.slice(0, parsedInputPath.length - 1)]
	
	const outputPath = formatPath([...rootPath, "verify"]);
	const errorPath = formatPath([...rootPath, "error"]);

	// init pinata sdk
	const pinata = new pinataSDK({ pinataApiKey, pinataSecretApiKey });

	// get image file from url
	const imageDataResponse = await axios.get(value.params.tempImageUrl, {
		responseType: "arraybuffer",
	})
	.catch(e => console.error('Fail get image', e));

	// image file to readable stream
	const imageDataStream = new Readable();
	imageDataStream.push(imageDataResponse.data);
	imageDataStream.push(null);

	// upload image to pinata
	const options = {
		pinataMetadata: {
			name: `${taskId}_image`,
		},
		pinataOptions: {
			cidVersion: 0,
		},
	};

	// upload image to ipfs
	try{
		uploadImgRes = await pinata.pinFileToIPFS(imageDataStream, options)
	}
	catch(e) {
		console.error('Fail image upload', e);
		ain.db.ref(errorPath).setValue({
			value: {
				state:"Error",
				msg:"Image upload fail. check your inforamtion of Image"
			},
		})
		.catch((e) => {
			console.error(`setValue failure:`, e);
			res.status(502).send("image upload fail");
		});

		return;
	}

	let old_attributes_modify = [];
	await Object.values(value.params.old_attributes).map((item, idx) => {
		old_attributes_modify.push(item);
	})

	// metadata will be writed in ipfs
	const metadata = {
		old_attributes: old_attributes_modify,
		old_description: value.params.old_description,
		old_image: value.params.old_image,
		old_name: value.params.old_name,
		namespaces: {
			ainetwork: {
				ain_tx: transaction.hash, 
				old_metadata: value.contract_info.old_metadata, 
				updated_at: Date.now()
			},
		}
	}

	const metadataOption = {
		pinataMetadata: {
			name: `${taskId}_metadata`,
		},
		pinataOptions: {
			cidVersion: 0,
		},
	}

	try{
		// upload metadata to ipfs
		uploadMetadataRes = await pinata.pinJSONToIPFS(metadata, metadataOption);
	}
	catch (e){
		// if fail upload metadata, uploaded image is unpined in pinata.
		console.error('Fail ipfs upload', e);
		await pinata.unpin(uploadImgRes.IpfsHash);
		await ain.db.ref(errorPath).setValue({
			value: {
				state:"Error",
				msg:"Metadata upload fail. check your inforamtion of metadata"
			},
		})
		.catch((e) => {
			console.error(`setValue failure:`, e);
		});

		return;
	}

	const ainRes = await ain.db.ref(outputPath).setValue({
		value: {
			contract:{
				network:value.contract_info.network,
				chain_id:value.contract_info.chain_id,
				account:value.contract_info.account,
				token_id:value.contract_info.token_id,
				new_metadata: uploadMetadataRes.IpfsHash,
			},
			verified_at: Date.now(),
			trigger_verification_account: BOT_ADDRESS,
		},
	}).catch((e) => {
		console.error(`setValue failure:`, e);
	});
	console.log(`Success! \n image upload tx : ${uploadImgRes.IpfsHash} \n metadata upload tx : ${uploadMetadataRes.IpfsHash}`);

})

// app.post('/trigger', async (req, res) => {

//     // Example of the transaction shape: refer to tx_sample.json

//     // 1. check tx meets precondition
//     const tx = req.body.transaction;
//     if (!tx || !tx.tx_body || !tx.tx_body.operation) {
//         console.log(`Invalid tx: ${JSON.stringify(tx)}`);
//         return;
//     }
//     if (tx.tx_body.operation.type !== 'SET_VALUE') {
//         console.log(`Not supported tx type: ${tx.tx_body.operation.type}`)
//         return;
//     }

//     const inputPath = tx.tx_body.operation.ref;
//     const parsedInputPath = parsePath(inputPath);
//     if (parsedInputPath.length !== 7 ||
//         parsedInputPath[0] !== 'apps' ||
//         parsedInputPath[1] !== 'sf_ainft_0' ||
//         parsedInputPath[2] !== 'sd_inpainting' ||
//         parsedInputPath[6] !== 'input') {
//         console.log(`Not supported path pattern: ${inputPath}`);
//         return;
//     }

//     // 2. call GET /tasks/{task_id}
//     const inputValue = tx.tx_body.operation.value;
//     const options = JSON.parse(inputValue);

//     const task_id = options.task_id;
//     const pickedOptions = (({ prompt, seed, guidance_scale }) => ({ prompt, seed, guidance_scale }))(options);
//     pickedOptions = {...pickedOptions, ...{"num_images_per_prompt": 1}};

//     // pickedOptions = {
//     //     prompt: ...,
//     //     seed: ...,
//     //     guidance_scale: ...,
//     //     num_images_per_prompt: 1
//     // }

//     const SDResult = await axios.get(`${SD_INPAINTING_ENDPOINT}/tasks/${task_id}`, pickedOptions);
//     console.log(JSON.stringify(SDResult.data,null,2));

//     if (SDResult.data.status !== "completed") {
//         console.log(`Task ${task_id} is not completed!`);
//         res.send(`Task ${task_id} is not completed!`);
//         return;
//     }


//     //pre-check the output path
//     const outputPath = formatPath([...parsedInputPath.slice(0, parsedInputPath.length - 1), "signed_data"]);
//     const result = await ain.db.ref(outputPath).setValue({
//       value: `${JSON.stringify(SDResult.data, null, 2)}`,
//       nonce: -1,
//     })
//     .catch((e) => {
//       console.error(`setValue failure:`, e);
//     });

// });

app.listen(port, () => {
	console.log(`App listening at http://localhost:${port}`);
});
