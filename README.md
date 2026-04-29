Securing Banking Transactions with Blockchain: A Tokenless Approach

A robust full-stack web application designed to simulate and manage secure banking transactions leveraging blockchain technology without the overhead of cryptocurrency tokens. The system ensures data integrity and immutability for financial records using the MERN stack.

Features

* Tokenless Blockchain Ledger: Utilizes cryptographic hashing (like SHA-256) to chain transaction blocks together, ensuring security without needing a tradable coin.
* Secure Authentication: JWT-based user login and registration to ensure only authorized users can initiate transfers.
* Transaction History: A transparent and immutable ledger view where users can verify past transactions.
* Tamper Detection: Built-in validation mechanisms to flag if any block in the transaction history has been altered.

Technologies Used

* MongoDB
* Express.js
* React.js
* Node.js
* Cryptography Libraries (for hashing)

Setup Instructions

1. Clone the Repository

git clone https://github.com/Hemanthannamneedi/Securing-Banking-Transactions-with-Blockchain.git
cd Securing-Banking-Transactions-with-Blockchain

2. Install Dependencies

You will need to install the Node modules for both the backend server and the frontend client.

# Install backend dependencies
cd backend
npm install

# Install frontend dependencies
cd ../frontend
npm install

3. Configure Environment Variables

Create a .env file in your backend directory and add your MongoDB connection string and secure keys:
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_secure_random_string
PORT=5000

4. Run the Application

You will need two terminal windows to run both servers simultaneously.

Terminal 1 (Backend):
cd backend
npm start
# The server will run on http://localhost:5000

Terminal 2 (Frontend):
cd frontend
npm start
# The React app will run on http://localhost:3000

Usage

* Register/Login: Create a secure account to access the banking dashboard.
* Initiate Transfer: Send funds to other registered accounts. The transaction is instantly verified and added to the next block.
* Verify Ledger: View the blockchain ledger to see the cryptographic hash linking your transaction to previous ones, ensuring the data has not been compromised.

File Structure
* backend/ - Express server, Mongoose models, API routes, and blockchain logic.
* frontend/ - React components, context/state management, and UI styling.
* package.json - Project metadata and shared scripts (if using a monorepo structure).
* backend/ - Express server, Mongoose models, API routes, and blockchain logic.
* frontend/ - React components, context/state management, and UI styling.
* package.json - Project metadata and shared scripts (if using a monorepo structure).
