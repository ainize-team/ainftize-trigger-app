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
	let uploadMetadataRes; // for catch error

	const inputPath = transaction.tx_body.operation.ref;
	const parsedInputPath = parsePath(inputPath);

	// pre-check the output path
	const outputPath = await formatPath([...parsedInputPath.slice(0, parsedInputPath.length - 1), "verify"]);
	const errorPath = formatPath([...parsedInputPath.slice(0, parsedInputPath.length - 1), "error"]);

	// init pinata sdk
	const pinata = new pinataSDK({ pinataApiKey, pinataSecretApiKey });

	// get generated ainft image url with with task id
	const result = await axios.get(`${process.env.SD_INPAINTING_ENDPOINT}/tasks/${taskId}`);

	const imageUrls = result.data.result;

	// get image file from url
	const imageDataResponse = await axios.get(imageUrls[value.params.index || 1], {
		responseType: "arraybuffer",
	});

	// for test
	const imageBuffer = fs.readFileSync(__dirname + "/test.png");

	// image file to readable stream
	const imageDataStream = new Readable();
	imageDataStream.push(imageBuffer);
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
		await pinata.pinFileToIPFS(imageDataStream, options)
	}
	catch(e) {
		ain.db.ref(errorPath).setValue({
			value: {
				state:"Error",
				msg:"Image upload fail. check your inforamtion of Image"
			},
		})
		.then(res => console.log(res))
		.catch((e) => {
			console.error(`setValue failure:`, e);
			res.status(502).send("image upload fail");
		});

		return;
	}

	// get origin metadata
	const originMetadata = await axios.get(`https://gateway.pinata.cloud/ipfs/${value.contract.old_metadata}/${value.contract.token_id}`, {
		headers: {
			'Accept': '*/*'
		}
	});

	// metadata will be writed in ipfs
	const metadata = {
		attributes: originMetadata.attributes,
		description: originMetadata.description,
		image: originMetadata.image,
		name: originMetadata.name,
		namespaces: {
			ainetwork: {
				ain_tx: transaction.hash, // need 
				old_metadata: value.contract.old_metadata, // do not apply yet
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
		console.error(e);
		await pinata.unpin(uploadImgRes.IpfsHash);
		await ain.db.ref(errorPath).setValue({
			value: {
				state:"Error",
				msg:"Metadata upload fail. check your inforamtion of metadata"
			},
		})
		.then(res => console.log(res))
		.catch((e) => {
			console.error(`setValue failure:`, e);
		});

		return;
	}

	await ain.db.ref(outputPath).setValue({
		value: {
			contract:{
				network:value.contract.network,
				chain_id:value.contract.chain_id,
				account:value.contract.account,
				token_id:value.contract.token_id,
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
