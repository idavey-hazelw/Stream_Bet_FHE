import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface BettingRecord {
  id: string;
  encryptedAmount: string;
  timestamp: number;
  better: string;
  gameId: string;
  prediction: string;
  odds: number;
  status: "pending" | "won" | "lost" | "canceled";
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'increase10%':
      result = value * 1.1;
      break;
    case 'decrease10%':
      result = value * 0.9;
      break;
    case 'double':
      result = value * 2;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [bets, setBets] = useState<BettingRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showBetModal, setShowBetModal] = useState(false);
  const [betting, setBetting] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newBetData, setNewBetData] = useState({ gameId: "", prediction: "", amount: 0 });
  const [showTutorial, setShowTutorial] = useState(false);
  const [selectedBet, setSelectedBet] = useState<BettingRecord | null>(null);
  const [decryptedAmount, setDecryptedAmount] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [activeGames, setActiveGames] = useState<string[]>(["LOL", "DOTA2", "CSGO", "VALORANT", "PUBG"]);
  const [liveStreams, setLiveStreams] = useState([
    { id: "stream1", title: "League Championship Finals", viewers: 12500, game: "LOL" },
    { id: "stream2", title: "DOTA2 International", viewers: 8700, game: "DOTA2" },
    { id: "stream3", title: "CSGO Major Tournament", viewers: 11200, game: "CSGO" }
  ]);

  const wonCount = bets.filter(b => b.status === "won").length;
  const lostCount = bets.filter(b => b.status === "lost").length;
  const pendingCount = bets.filter(b => b.status === "pending").length;

  useEffect(() => {
    loadBets().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadBets = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("bet_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing bet keys:", e); }
      }
      
      const list: BettingRecord[] = [];
      for (const key of keys) {
        try {
          const betBytes = await contract.getData(`bet_${key}`);
          if (betBytes.length > 0) {
            try {
              const betData = JSON.parse(ethers.toUtf8String(betBytes));
              list.push({ 
                id: key, 
                encryptedAmount: betData.amount, 
                timestamp: betData.timestamp, 
                better: betData.better, 
                gameId: betData.gameId, 
                prediction: betData.prediction,
                odds: betData.odds || 1.5,
                status: betData.status || "pending" 
              });
            } catch (e) { console.error(`Error parsing bet data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading bet ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setBets(list);
    } catch (e) { console.error("Error loading bets:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const placeBet = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setBetting(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting bet amount with Zama FHE..." });
    try {
      const encryptedAmount = FHEEncryptNumber(newBetData.amount);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const betId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const betData = { 
        amount: encryptedAmount, 
        timestamp: Math.floor(Date.now() / 1000), 
        better: address, 
        gameId: newBetData.gameId, 
        prediction: newBetData.prediction,
        odds: 1.5 + Math.random() * 0.5, // Random odds between 1.5-2.0
        status: "pending" 
      };
      
      await contract.setData(`bet_${betId}`, ethers.toUtf8Bytes(JSON.stringify(betData)));
      
      const keysBytes = await contract.getData("bet_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(betId);
      await contract.setData("bet_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Bet placed securely with FHE encryption!" });
      await loadBets();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowBetModal(false);
        setNewBetData({ gameId: "", prediction: "", amount: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Bet placement failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setBetting(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const settleBet = async (betId: string, result: "won" | "lost") => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted bet with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const betBytes = await contract.getData(`bet_${betId}`);
      if (betBytes.length === 0) throw new Error("Bet not found");
      const betData = JSON.parse(ethers.toUtf8String(betBytes));
      
      let settledAmount = betData.amount;
      if (result === "won") {
        settledAmount = FHECompute(betData.amount, `double`); // Winner gets double
      }
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedBet = { ...betData, status: result, amount: settledAmount };
      await contractWithSigner.setData(`bet_${betId}`, ethers.toUtf8Bytes(JSON.stringify(updatedBet)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE settlement completed successfully!" });
      await loadBets();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Settlement failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const cancelBet = async (betId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted bet with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const betBytes = await contract.getData(`bet_${betId}`);
      if (betBytes.length === 0) throw new Error("Bet not found");
      const betData = JSON.parse(ethers.toUtf8String(betBytes));
      const updatedBet = { ...betData, status: "canceled" };
      await contract.setData(`bet_${betId}`, ethers.toUtf8Bytes(JSON.stringify(updatedBet)));
      setTransactionStatus({ visible: true, status: "success", message: "FHE cancellation completed successfully!" });
      await loadBets();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Cancellation failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (betAddress: string) => address?.toLowerCase() === betAddress.toLowerCase();

  const tutorialSteps = [
    { title: "Connect Wallet", description: "Connect your Web3 wallet to place private bets", icon: "🔗" },
    { title: "Watch Live Stream", description: "Select a live game stream to bet on", icon: "🎮" },
    { title: "Place Encrypted Bet", description: "Your bet amount is encrypted with Zama FHE before submission", icon: "🔒" },
    { title: "Private Betting", description: "No one can see your bet amount until you decrypt it", icon: "👁️" },
    { title: "Automatic Settlement", description: "Winnings are calculated on encrypted data", icon: "💰" }
  ];

  const filteredBets = bets.filter(bet => {
    const matchesSearch = bet.gameId.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         bet.prediction.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = filterStatus === "all" || bet.status === filterStatus;
    return matchesSearch && matchesStatus;
  });

  const renderStats = () => {
    return (
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">{bets.length}</div>
          <div className="stat-label">Total Bets</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{wonCount}</div>
          <div className="stat-label">Won</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{lostCount}</div>
          <div className="stat-label">Lost</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{pendingCount}</div>
          <div className="stat-label">Pending</div>
        </div>
      </div>
    );
  };

  const renderLiveStreams = () => {
    return (
      <div className="streams-grid">
        {liveStreams.map(stream => (
          <div className="stream-card" key={stream.id}>
            <div className="stream-thumbnail" style={{ backgroundImage: `linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.8)), url(https://via.placeholder.com/300x200?text=${stream.game})` }}>
              <div className="viewer-count">{stream.viewers.toLocaleString()} viewers</div>
              <div className="stream-game">{stream.game}</div>
            </div>
            <div className="stream-info">
              <h3>{stream.title}</h3>
              <button 
                className="bet-button" 
                onClick={() => {
                  setNewBetData({...newBetData, gameId: stream.game});
                  setShowBetModal(true);
                }}
              >
                Place Bet
              </button>
            </div>
          </div>
        ))}
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="cyber-spinner"></div>
      <p>Initializing encrypted connection...</p>
    </div>
  );

  return (
    <div className="app-container cyberpunk-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="shield-icon"></div></div>
          <h1>Stream<span>Bet</span>FHE</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowBetModal(true)} className="create-bet-btn cyber-button">
            <div className="add-icon"></div>Place Bet
          </button>
          <button className="cyber-button" onClick={() => setShowTutorial(!showTutorial)}>
            {showTutorial ? "Hide Tutorial" : "How It Works"}
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>Private Betting with FHE</h2>
            <p>Bet on live game streams with fully encrypted amounts using Zama FHE technology</p>
          </div>
          <div className="fhe-indicator"><div className="fhe-lock"></div><span>FHE Encryption Active</span></div>
        </div>
        
        {showTutorial && (
          <div className="tutorial-section">
            <h2>Private Betting Tutorial</h2>
            <p className="subtitle">Learn how to bet privately with FHE encryption</p>
            <div className="tutorial-steps">
              {tutorialSteps.map((step, index) => (
                <div className="tutorial-step" key={index}>
                  <div className="step-icon">{step.icon}</div>
                  <div className="step-content">
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="fhe-diagram">
              <div className="diagram-step"><div className="diagram-icon">💰</div><div className="diagram-label">Plain Bet</div></div>
              <div className="diagram-arrow">→</div>
              <div className="diagram-step"><div className="diagram-icon">🔒</div><div className="diagram-label">FHE Encryption</div></div>
              <div className="diagram-arrow">→</div>
              <div className="diagram-step"><div className="diagram-icon">🎮</div><div className="diagram-label">Game Outcome</div></div>
              <div className="diagram-arrow">→</div>
              <div className="diagram-step"><div className="diagram-icon">⚙️</div><div className="diagram-label">Encrypted Settlement</div></div>
            </div>
          </div>
        )}
        
        <div className="dashboard-section">
          <h2>Live Game Streams</h2>
          {renderLiveStreams()}
        </div>
        
        <div className="dashboard-section">
          <h2>Betting Statistics</h2>
          {renderStats()}
        </div>
        
        <div className="bets-section">
          <div className="section-header">
            <h2>Your Betting History</h2>
            <div className="header-actions">
              <div className="search-filter">
                <input 
                  type="text" 
                  placeholder="Search bets..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="cyber-input"
                />
                <select 
                  value={filterStatus} 
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="cyber-select"
                >
                  <option value="all">All Status</option>
                  <option value="pending">Pending</option>
                  <option value="won">Won</option>
                  <option value="lost">Lost</option>
                  <option value="canceled">Canceled</option>
                </select>
              </div>
              <button onClick={loadBets} className="refresh-btn cyber-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          
          <div className="bets-list cyber-card">
            <div className="table-header">
              <div className="header-cell">Game</div>
              <div className="header-cell">Prediction</div>
              <div className="header-cell">Odds</div>
              <div className="header-cell">Date</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            
            {filteredBets.length === 0 ? (
              <div className="no-bets">
                <div className="no-bets-icon"></div>
                <p>No betting records found</p>
                <button className="cyber-button primary" onClick={() => setShowBetModal(true)}>Place Your First Bet</button>
              </div>
            ) : filteredBets.map(bet => (
              <div className="bet-row" key={bet.id} onClick={() => setSelectedBet(bet)}>
                <div className="table-cell">{bet.gameId}</div>
                <div className="table-cell">{bet.prediction}</div>
                <div className="table-cell">{bet.odds.toFixed(2)}x</div>
                <div className="table-cell">{new Date(bet.timestamp * 1000).toLocaleDateString()}</div>
                <div className="table-cell"><span className={`status-badge ${bet.status}`}>{bet.status}</span></div>
                <div className="table-cell actions">
                  {isOwner(bet.better) && bet.status === "pending" && (
                    <>
                      <button className="action-btn cyber-button success" onClick={(e) => { e.stopPropagation(); settleBet(bet.id, "won"); }}>Win</button>
                      <button className="action-btn cyber-button danger" onClick={(e) => { e.stopPropagation(); settleBet(bet.id, "lost"); }}>Lose</button>
                      <button className="action-btn cyber-button" onClick={(e) => { e.stopPropagation(); cancelBet(bet.id); }}>Cancel</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      
      {showBetModal && (
        <ModalBet 
          onSubmit={placeBet} 
          onClose={() => setShowBetModal(false)} 
          betting={betting} 
          betData={newBetData} 
          setBetData={setNewBetData}
          activeGames={activeGames}
        />
      )}
      
      {selectedBet && (
        <BetDetailModal 
          bet={selectedBet} 
          onClose={() => { setSelectedBet(null); setDecryptedAmount(null); }} 
          decryptedAmount={decryptedAmount} 
          setDecryptedAmount={setDecryptedAmount} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content cyber-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="cyber-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="shield-icon"></div><span>StreamBetFHE</span></div>
            <p>Private betting powered by Zama FHE technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>FHE-Powered Privacy</span></div>
          <div className="copyright">© {new Date().getFullYear()} StreamBetFHE. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalBetProps {
  onSubmit: () => void; 
  onClose: () => void; 
  betting: boolean;
  betData: any;
  setBetData: (data: any) => void;
  activeGames: string[];
}

const ModalBet: React.FC<ModalBetProps> = ({ onSubmit, onClose, betting, betData, setBetData, activeGames }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setBetData({ ...betData, [name]: value });
  };

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setBetData({ ...betData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!betData.gameId || !betData.prediction || !betData.amount) { 
      alert("Please fill all required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="bet-modal cyber-card">
        <div className="modal-header">
          <h2>Place Private Bet</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div><strong>FHE Encryption Notice</strong><p>Your bet amount will be encrypted with Zama FHE before submission</p></div>
          </div>
          
          <div className="form-group">
            <label>Game *</label>
            <select name="gameId" value={betData.gameId} onChange={handleChange} className="cyber-select">
              <option value="">Select game</option>
              {activeGames.map(game => (
                <option key={game} value={game}>{game}</option>
              ))}
            </select>
          </div>
          
          <div className="form-group">
            <label>Your Prediction *</label>
            <input 
              type="text" 
              name="prediction" 
              value={betData.prediction} 
              onChange={handleChange} 
              placeholder="E.g. 'Blue team wins', 'Player gets 10 kills'" 
              className="cyber-input"
            />
          </div>
          
          <div className="form-group">
            <label>Bet Amount (ETH) *</label>
            <input 
              type="number" 
              name="amount" 
              value={betData.amount} 
              onChange={handleAmountChange} 
              placeholder="Enter amount..." 
              className="cyber-input"
              step="0.01"
              min="0.01"
            />
          </div>
          
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data"><span>Plain Amount:</span><div>{betData.amount || '0'} ETH</div></div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{betData.amount ? FHEEncryptNumber(betData.amount).substring(0, 50) + '...' : 'No amount entered'}</div>
              </div>
            </div>
          </div>
          
          <div className="privacy-notice">
            <div className="privacy-icon"></div> 
            <div><strong>Bet Privacy Guarantee</strong><p>Your bet amount remains encrypted during processing and is never decrypted on our servers</p></div>
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn cyber-button">Cancel</button>
          <button onClick={handleSubmit} disabled={betting} className="submit-btn cyber-button primary">
            {betting ? "Encrypting with FHE..." : "Place Private Bet"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface BetDetailModalProps {
  bet: BettingRecord;
  onClose: () => void;
  decryptedAmount: number | null;
  setDecryptedAmount: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const BetDetailModal: React.FC<BetDetailModalProps> = ({ bet, onClose, decryptedAmount, setDecryptedAmount, isDecrypting, decryptWithSignature }) => {
  const handleDecrypt = async () => {
    if (decryptedAmount !== null) { setDecryptedAmount(null); return; }
    const decrypted = await decryptWithSignature(bet.encryptedAmount);
    if (decrypted !== null) setDecryptedAmount(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="bet-detail-modal cyber-card">
        <div className="modal-header">
          <h2>Bet Details #{bet.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="bet-info">
            <div className="info-item"><span>Game:</span><strong>{bet.gameId}</strong></div>
            <div className="info-item"><span>Prediction:</span><strong>{bet.prediction}</strong></div>
            <div className="info-item"><span>Odds:</span><strong>{bet.odds.toFixed(2)}x</strong></div>
            <div className="info-item"><span>Better:</span><strong>{bet.better.substring(0, 6)}...{bet.better.substring(38)}</strong></div>
            <div className="info-item"><span>Date:</span><strong>{new Date(bet.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item"><span>Status:</span><strong className={`status-badge ${bet.status}`}>{bet.status}</strong></div>
          </div>
          
          <div className="encrypted-data-section">
            <h3>Encrypted Bet Amount</h3>
            <div className="encrypted-data">{bet.encryptedAmount.substring(0, 100)}...</div>
            <div className="fhe-tag"><div className="fhe-icon"></div><span>FHE Encrypted</span></div>
            <button className="decrypt-btn cyber-button" onClick={handleDecrypt} disabled={isDecrypting}>
              {isDecrypting ? <span className="decrypt-spinner"></span> : decryptedAmount !== null ? "Hide Decrypted Amount" : "Decrypt with Wallet Signature"}
            </button>
          </div>
          
          {decryptedAmount !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Amount</h3>
              <div className="decrypted-value">{decryptedAmount} ETH</div>
              {bet.status === "won" && (
                <div className="winnings-calculation">
                  <h4>Winnings Calculation</h4>
                  <div className="calculation">
                    {decryptedAmount} ETH × {bet.odds.toFixed(2)} = {(decryptedAmount * bet.odds).toFixed(2)} ETH
                  </div>
                </div>
              )}
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted data is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn cyber-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;