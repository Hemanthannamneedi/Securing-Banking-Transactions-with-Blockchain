const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');
const nunjucks = require('nunjucks');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const port = 7000;

// --- CONFIGURATION ---
app.use(bodyParser.urlencoded({ extended: true }));

nunjucks.configure(path.join(__dirname, 'templates'), { 
    autoescape: true, 
    express: app 
});

// --- DATABASE SETUP ---
const uri = 'mongodb://127.0.0.1:27017/';
const client = new MongoClient(uri);
let db, usersCollection, transactionsCollection;

async function connectDB() {
    await client.connect();
    db = client.db('securechain_bank');
    usersCollection = db.collection('users');
    transactionsCollection = db.collection('transactions');
    console.log("Connected to MongoDB!");
}
connectDB().catch(console.error);

// --- BLOCKCHAIN ALGORITHM ---
class Block {
    constructor(index, timestamp, transaction_data, previous_hash) {
        this.index = index;
        this.timestamp = timestamp;
        this.transaction_data = transaction_data;
        this.previous_hash = previous_hash;
        this.hash = this.calculateHash();
    }
    calculateHash() {
        const blockString = JSON.stringify({
            index: this.index, 
            timestamp: this.timestamp,
            transaction_data: this.transaction_data, 
            previous_hash: this.previous_hash
        });
        return crypto.createHash('sha256').update(blockString).digest('hex');
    }
}

class Blockchain {
    constructor() { this.chain = [this.createGenesisBlock()]; }
    createGenesisBlock() { return new Block(0, new Date().toISOString(), "Genesis Block", "0"); }
    
    async addBlock(transactionData) {
        const lastDbBlock = await transactionsCollection.find().sort({ _id: -1 }).limit(1).toArray();
        let prevHash = "0";
        let newIndex = 1;
        if (lastDbBlock.length > 0) {
            prevHash = lastDbBlock[0].hash;
            newIndex = lastDbBlock[0].block_index + 1;
        }
        const newBlock = new Block(newIndex, new Date().toISOString(), transactionData, prevHash);
        this.chain.push(newBlock);
        return newBlock;
    }
}
const bankBlockchain = new Blockchain();

// --- ROUTES ---

app.get('/', (req, res) => res.render('index.html'));
app.get('/login', (req, res) => res.render('login.html'));

app.post('/login', async (req, res) => {
    const { action, email, password, role, bank } = req.body;
    
    if (action === 'register') {
        const existingUser = await usersCollection.findOne({ email });
        if (existingUser) return res.send("User already exists!");
        
        const newUser = {
            email, password, role, 
            bank: bank || 'Standard Bank',
            first_name: "", last_name: "", mobile: "", address: "",
            account_number: null, status: "pending_approval", balance: 0.0
        };
        await usersCollection.insertOne(newUser);
        return res.redirect(`/login?role=${role}`);
    } else {
        const user = await usersCollection.findOne({ email, password, role });
        if (user) {
            if (role === 'admin') return res.redirect('/admin');
            if (role === 'agent') return res.redirect('/agent');
            if (role === 'auditor') return res.redirect('/auditor');
            return res.redirect(`/user/${user._id}`);
        }
        return res.send("Invalid credentials!");
    }
});

// DOUBLE-ENTRY TRANSFER LOGIC
async function processTransfer(txId) {
    const tx = await transactionsCollection.findOne({ _id: new ObjectId(txId) });
    if (tx && tx.transaction_data.status === "pending_auditor_approval") {
        await usersCollection.updateOne({ _id: new ObjectId(tx.transaction_data.user_id) }, { $inc: { balance: -tx.transaction_data.amount } });
        await usersCollection.updateOne({ account_number: tx.transaction_data.recipient_account }, { $inc: { balance: tx.transaction_data.amount } });
        await transactionsCollection.updateOne({ _id: new ObjectId(txId) }, { $set: { "transaction_data.status": "approved" } });
    }
}

// --- ADMIN ROUTES ---
app.get('/admin', async (req, res) => {
    const pending_users = await usersCollection.find({ status: "pending_approval" }).toArray();
    const pending_transfers = await transactionsCollection.find({ "transaction_data.status": "pending_auditor_approval" }).toArray();
    const pending_deposits = await transactionsCollection.find({ "transaction_data.status": "pending_agent_approval" }).toArray();
    res.render('admin.html', { pending_users, pending_transfers, pending_deposits });
});

app.post('/admin/approve/:userId', async (req, res) => {
    const new_account_number = Math.floor(10000000000 + Math.random() * 90000000000).toString();
    await usersCollection.updateOne({ _id: new ObjectId(req.params.userId) }, { $set: { account_number: new_account_number, status: "active" } });
    res.redirect('/admin');
});

app.post('/admin/approve_transfer/:txId', async (req, res) => {
    await processTransfer(req.params.txId);
    res.redirect('/admin');
});

app.post('/admin/approve_deposit/:txId', async (req, res) => {
    const tx = await transactionsCollection.findOne({ _id: new ObjectId(req.params.txId) });
    if (tx && tx.transaction_data.status === "pending_agent_approval") {
        await usersCollection.updateOne({ _id: new ObjectId(tx.transaction_data.user_id) }, { $inc: { balance: tx.transaction_data.amount } });
        await transactionsCollection.updateOne({ _id: new ObjectId(req.params.txId) }, { $set: { "transaction_data.status": "approved" } });
    }
    res.redirect('/admin');
});

// Admin unlocks a user account

app.post('/admin/unlock/:userId', async (req, res) => {
    await usersCollection.updateOne(
        { _id: new ObjectId(req.params.userId) }, 
        { $set: { status: "active" } }
    );
    res.redirect('/behavior'); // This seamlessly refreshes the admin page
});

// --- USER ROUTES ---
app.get('/user/:userId', async (req, res) => {
    const user = await usersCollection.findOne({ _id: new ObjectId(req.params.userId) });
    const transactions = await transactionsCollection.find({
        $or: [{ "transaction_data.user_id": req.params.userId }, { "transaction_data.recipient_account": user.account_number }]
    }).sort({ timestamp: -1 }).toArray();
    res.render('user.html', { user, transactions });
});

app.post('/user/edit/:userId', async (req, res) => {
    const { first_name, last_name, mobile, address } = req.body;
    await usersCollection.updateOne({ _id: new ObjectId(req.params.userId) }, { $set: { first_name, last_name, mobile, address } });
    res.redirect(`/user/${req.params.userId}`);
});

app.post('/user/transfer/:userId', async (req, res) => {
    const { recipient_account, amount } = req.body;
    const amountFloat = parseFloat(amount);
    
    const sender = await usersCollection.findOne({ _id: new ObjectId(req.params.userId) });
    const receiver = await usersCollection.findOne({ account_number: recipient_account });
    
    if (!receiver) return res.send("Error: Recipient account number does not exist.");
    if (sender.balance < amountFloat) return res.send("Error: Insufficient funds.");

    let txStatus = "pending_auditor_approval";
    let isFraud = false;
    if (amountFloat > 50000) { txStatus = "flagged_fraud"; isFraud = true; }

    const transaction_data = {
        user_id: req.params.userId,
        sender_account: sender.account_number,
        recipient_account: recipient_account,
        amount: amountFloat,
        type: "transfer",
        status: txStatus
    };
    
    const newBlock = await bankBlockchain.addBlock(transaction_data);
    await transactionsCollection.insertOne(newBlock);

    if (isFraud) await usersCollection.updateOne({ _id: new ObjectId(req.params.userId) }, { $set: { status: "locked" } });
    res.redirect(`/user/${req.params.userId}`);
});

app.post('/user/deposit/:userId', async (req, res) => {
    const { deposit_amount } = req.body;
    const amountFloat = parseFloat(deposit_amount);
    const depositor = await usersCollection.findOne({ _id: new ObjectId(req.params.userId) });

    let txStatus = "pending_agent_approval";
    let isFraud = false;
    if (amountFloat > 50000) { txStatus = "flagged_fraud"; isFraud = true; }

    const transaction_data = {
        user_id: req.params.userId,
        account_number: depositor.account_number, 
        amount: amountFloat,
        type: "deposit",
        status: txStatus
    };
    
    const newBlock = await bankBlockchain.addBlock(transaction_data);
    await transactionsCollection.insertOne(newBlock);

    if (isFraud) await usersCollection.updateOne({ _id: new ObjectId(req.params.userId) }, { $set: { status: "locked" } });
    res.redirect(`/user/${req.params.userId}`);
});

// --- AUDITOR ROUTES ---
app.get('/auditor', async (req, res) => {
    const pending_transactions = await transactionsCollection.find({ "transaction_data.status": "pending_auditor_approval" }).toArray();
    res.render('auditor.html', { pending_transactions });
});

app.post('/auditor/approve/:txId', async (req, res) => {
    await processTransfer(req.params.txId);
    res.redirect('/auditor');
});

// --- AGENT ROUTES ---
app.get('/agent', async (req, res) => {
    const pending_deposits = await transactionsCollection.find({ "transaction_data.status": "pending_agent_approval" }).toArray();
    res.render('agent.html', { pending_deposits });
});

app.post('/agent/approve/:txId', async (req, res) => {
    const tx = await transactionsCollection.findOne({ _id: new ObjectId(req.params.txId) });
    if (tx && tx.transaction_data.status === "pending_agent_approval") {
        await usersCollection.updateOne({ _id: new ObjectId(tx.transaction_data.user_id) }, { $inc: { balance: tx.transaction_data.amount } });
        await transactionsCollection.updateOne({ _id: new ObjectId(req.params.txId) }, { $set: { "transaction_data.status": "approved" } });
    }
    res.redirect('/agent');
});


// --- BEHAVIOR ROUTE ---
app.get('/behavior', async (req, res) => {
    const flagged_transactions = await transactionsCollection.find({ "transaction_data.amount": { $gt: 50000 } }).toArray();
    const users = await usersCollection.find().toArray();
    
    const chartData = flagged_transactions.map(tx => tx.transaction_data.amount);
    const chartLabels = flagged_transactions.map(tx => {
        const id = tx.transaction_data.user_id ? tx.transaction_data.user_id.toString() : "000000";
        return `ID: ${id.slice(-6)}...`;
    });

    // Capture the role from the URL (default to 'unknown' if not provided)
    const currentRole = req.query.role || 'unknown';

    res.render('behavior.html', { 
        flagged_transactions, users,
        chartData: JSON.stringify(chartData), chartLabels: JSON.stringify(chartLabels),
        currentRole: currentRole // Pass the role to the frontend template
    });
});

app.listen(port, () => console.log(`SecureChain App running at http://127.0.0.1:${port}`));