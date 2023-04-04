const express = require('express');
const AinJs = require('@ainblockchain/ain-js').default;
const axios = require('axios');
const dotenv = require('dotenv');
const pinataSDK = require("@pinata/sdk");
const fs = require("fs");
const { Readable } = require("stream");
const NodeCache = require("node-cache");
dotenv.config();

const { parsePath, formatPath, validateTransaction } = require('./util');

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

	// have to check transaction
	validateTransaction(transaction.tx_body)

	const value = transaction.tx_body.operation.value;
	const taskId = value.params.task_id;
	if (cache.get(taskId)) {
		cache.ttl(taskId, 60);
		return;
	}

	// if request is first request, set cache 
	cache.set(taskId, true, 60);

	// for catch error
	let uploadMetadataRes;
	let uploadImgRes;

	const inputPath = transaction.tx_body.operation.ref;
	const parsedInputPath = parsePath(inputPath);

	// pre-check the output path
	const rootPath = parsedInputPath.slice(0, parsedInputPath.length - 1);

	const outputPath = formatPath([...rootPath, "verify"]);
	const errorPath = formatPath([...rootPath, "error"]);

	// init pinata sdk
	const pinata = new pinataSDK({ pinataApiKey, pinataSecretApiKey });

	// get image file from url
	const imageDataResponse = await axios.get(value.params.temp_image_url, {
		responseType: "arraybuffer",
	})
	.catch(e => {
		console.error('Fail get image', e)
		return;
	});

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
	try {
		uploadImgRes = await pinata.pinFileToIPFS(imageDataStream, options);
	}
	catch (e) {
		console.error('Fail image upload', e);
		ain.db.ref(errorPath).setValue({
			value: {
				state: "Error",
				msg: "Image upload fail. check your inforamtion of Image"
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
				old_metadata: value.contract.old_metadata,
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

	try {
		// upload metadata to ipfs
		uploadMetadataRes = await pinata.pinJSONToIPFS(metadata, metadataOption);
	}
	catch (e) {
		// if fail upload metadata, uploaded image is unpined in pinata.
		console.error('Fail ipfs upload', e);
		await pinata.unpin(uploadImgRes.IpfsHash);
		await ain.db.ref(errorPath).setValue({
			value: {
				state: "Error",
				msg: "Metadata upload fail. check your inforamtion of metadata"
			},
		})
			.catch((e) => {
				console.error(`setValue failure:`, e);
				return;
			});

		return;
	}

	await ain.db.ref(outputPath).setValue({
		nonce: -1,
		gas_price: 500,
		value: {
			contract: {
				network: value.contract.network,
				chain_id: value.contract.chain_id,
				account: value.contract.account,
				token_id: value.contract.token_id,
				new_metadata: uploadMetadataRes.IpfsHash,
			},
			verified_at: Date.now(),
			trigger_verification_account: BOT_ADDRESS,
		},
	})
	.catch((e) => {
		console.error(`setValue failure:`, e);
		return;
	});
	console.log(`Success! \n image upload tx : ${uploadImgRes.IpfsHash} \n metadata upload tx : ${uploadMetadataRes.IpfsHash}`);

})

app.listen(port, () => {
	console.log(`App listening at http://localhost:${port}`);
});
