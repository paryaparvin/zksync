import {
    AbstractJSONRPCTransport,
    HTTPTransport,
    WSTransport
} from "./transport";
import { utils, ethers, Contract } from "ethers";
import {
    AccountState,
    Address,
    Token,
    TransactionReceipt,
    PriorityOperationReceipt
} from "./types";
import { sleep, SYNC_GOV_CONTRACT_INTERFACE } from "./utils";

export interface ContractAddress {
    mainContract: string;
    govContract: string;
}

export async function getDefaultProvider(
    network: "localhost" | "testnet",
    transport: "WS" | "HTTP" = "WS"
): Promise<Provider> {
    if (network == "localhost") {
        if (transport == "WS") {
            return await Provider.newWebsocketProvider("ws://127.0.0.1:3031");
        } else if (transport == "HTTP") {
            return await Provider.newHttpProvider("http://127.0.0.1:3030");
        }
    } else if (network == "testnet") {
        if (transport == "WS") {
            return await Provider.newWebsocketProvider(
                "wss://testnet.matter-labs.io/jsrpc-ws"
            );
        } else if (transport == "HTTP") {
            return await Provider.newHttpProvider(
                "https://testnet.matter-labs.io/jsrpc"
            );
        }
    }
}

export class Provider {
    contractAddress: ContractAddress;
    private constructor(public transport: AbstractJSONRPCTransport) {}

    static async newWebsocketProvider(address: string): Promise<Provider> {
        const transport = await WSTransport.connect(address);
        const provider = new Provider(transport);
        provider.contractAddress = await provider.getContractAddress();
        return provider;
    }

    static async newHttpProvider(
        address: string = "http://127.0.0.1:3030"
    ): Promise<Provider> {
        const transport = new HTTPTransport(address);
        const provider = new Provider(transport);
        provider.contractAddress = await provider.getContractAddress();
        return provider;
    }

    // return transaction hash (e.g. 0xdead..beef)
    async submitTx(tx: any): Promise<string> {
        return await this.transport.request("tx_submit", [tx]);
    }

    async getContractAddress(): Promise<ContractAddress> {
        return await this.transport.request("contract_address", null);
    }

    async getState(address: Address): Promise<AccountState> {
        return await this.transport.request("account_info", [address]);
    }

    // get transaction status by its hash (e.g. 0xdead..beef)
    async getTxReceipt(txHash: string): Promise<TransactionReceipt> {
        return await this.transport.request("tx_info", [txHash]);
    }

    async getPriorityOpStatus(
        serialId: number
    ): Promise<PriorityOperationReceipt> {
        return await this.transport.request("ethop_info", [serialId]);
    }

    async notifyPriorityOp(
        serialId: number,
        action: "COMMIT" | "VERIFY"
    ): Promise<PriorityOperationReceipt> {
        if (this.transport.subscriptionsSupported()) {
            return await new Promise(resolve => {
                const sub = this.transport.subscribe(
                    "ethop_subscribe",
                    [serialId, action],
                    "ethop_unsubscribe",
                    resp => {
                        sub.then(sub => sub.unsubscribe());
                        resolve(resp);
                    }
                );
            });
        } else {
            let notifyDone = false;
            while (!notifyDone) {
                const priorOpStatus = await this.getPriorityOpStatus(serialId);
                if (priorOpStatus.block) {
                    if (action == "COMMIT") {
                        notifyDone = priorOpStatus.block.committed;
                    } else {
                        notifyDone = priorOpStatus.block.verified;
                    }
                }
                await sleep(3000);
            }
        }
    }

    async notifyTransaction(
        hash: string,
        action: "COMMIT" | "VERIFY"
    ): Promise<TransactionReceipt> {
        if (this.transport.subscriptionsSupported()) {
            return await new Promise(resolve => {
                const sub = this.transport.subscribe(
                    "tx_subscribe",
                    [hash, action],
                    "tx_unsubscribe",
                    resp => {
                        sub.then(sub => sub.unsubscribe());
                        resolve(resp);
                    }
                );
            });
        } else {
            let notifyDone = false;
            while (!notifyDone) {
                const transactionStatus = await this.getTxReceipt(hash);
                if (transactionStatus.block) {
                    if (action == "COMMIT") {
                        notifyDone = transactionStatus.block.committed;
                    } else {
                        notifyDone = transactionStatus.block.verified;
                    }
                }
                await sleep(3000);
            }
        }
    }

    async disconnect() {
        return await this.transport.disconnect();
    }
}

export class ETHProxy {
    constructor(
        private ethersProvider: ethers.providers.Provider,
        public contractAddress: ContractAddress
    ) {}

    async resolveTokenId(token: Token): Promise<number> {
        if (token == "ETH") {
            return 0;
        } else {
            const syncContract = new Contract(
                this.contractAddress.govContract,
                SYNC_GOV_CONTRACT_INTERFACE,
                this.ethersProvider
            );
            const tokenId = await syncContract.tokenIds(token);
            if (tokenId == 0) {
                throw new Error(
                    `ERC20 token is not supported address: ${token}`
                );
            }
            return tokenId;
        }
    }
}
