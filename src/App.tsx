import React, { useState, useEffect, useRef } from 'react';
import { 
  GoogleAuthProvider, 
  signInWithPopup, 
  onAuthStateChanged, 
  signOut, 
  User as FirebaseUser 
} from 'firebase/auth';
import { 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  onSnapshot, 
  serverTimestamp, 
  Timestamp,
  addDoc,
  deleteDoc,
  query
} from 'firebase/firestore';
import { auth, db } from './firebase';
import { parseThoughtsFromText, parseThoughtsFromPdf, parseThoughtsFromUrl, ExtractedThought } from './services/geminiService';
import mammoth from 'mammoth';
import { 
  Quote, 
  Upload, 
  LogOut, 
  Plus, 
  Trash2, 
  Sparkles, 
  Loader2, 
  BookOpen,
  RefreshCw,
  Link as LinkIcon,
  X
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Types ---
interface Thought {
  id: string;
  content: string;
  source?: string;
  sourceId?: string;
  createdAt: Timestamp;
  userId: string;
}

interface SourceDocument {
  id: string;
  name: string;
  type: 'file' | 'url';
  isActive: boolean;
  createdAt: Timestamp;
  userId: string;
}

interface DailySelection {
  date: string;
  thoughtIds: string[];
  userId: string;
}

// --- Components ---

const ErrorBoundary: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [hasError, setHasError] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      setHasError(true);
      setErrorMsg(event.error?.message || 'An unexpected error occurred');
    };
    window.addEventListener('error', handleError);
    return () => window.removeEventListener('error', handleError);
  }, []);

  if (hasError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50 p-4">
        <div className="max-w-md w-full bg-white p-8 rounded-2xl shadow-sm border border-stone-200">
          <h2 className="text-2xl font-serif italic text-stone-800 mb-4">Something went wrong</h2>
          <p className="text-stone-600 mb-6">{errorMsg}</p>
          <button 
            onClick={() => window.location.reload()}
            className="w-full py-3 bg-stone-800 text-white rounded-xl hover:bg-stone-700 transition-colors"
          >
            Refresh Page
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
};

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [sourceDocuments, setSourceDocuments] = useState<SourceDocument[]>([]);
  const [dailyThoughts, setDailyThoughts] = useState<Thought[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isUrlModalOpen, setIsUrlModalOpen] = useState(false);
  const [isCleanupModalOpen, setIsCleanupModalOpen] = useState(false);
  const [duplicateCount, setDuplicateCount] = useState(0);
  const [isCleaning, setIsCleaning] = useState(false);
  const [docUrl, setDocUrl] = useState('');
  const [googleAccessToken, setGoogleAccessToken] = useState<string | null>(localStorage.getItem('google_drive_token'));
  const [loginError, setLoginError] = useState<string | null>(null);
  const [view, setView] = useState<'daily' | 'all' | 'sources'>('daily');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Auth ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        // Ensure user doc exists
        const userRef = doc(db, 'users', currentUser.uid);
        const userSnap = await getDoc(userRef);
        if (!userSnap.exists()) {
          await setDoc(userRef, {
            uid: currentUser.uid,
            email: currentUser.email,
            displayName: currentUser.displayName,
            createdAt: serverTimestamp()
          });
        }
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // --- Data Sync ---
  useEffect(() => {
    if (!user) return;

    const thoughtsQuery = query(collection(db, 'users', user.uid, 'thoughts'));
    const thoughtsUnsubscribe = onSnapshot(thoughtsQuery, (snapshot) => {
      const thoughtsList = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as Thought));
      setThoughts(thoughtsList);
    }, (error) => {
      console.error("Firestore Error (Thoughts):", error);
    });

    const sourcesQuery = query(collection(db, 'users', user.uid, 'source_documents'));
    const sourcesUnsubscribe = onSnapshot(sourcesQuery, (snapshot) => {
      const sourcesList = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as SourceDocument));
      setSourceDocuments(sourcesList);
    }, (error) => {
      console.error("Firestore Error (Sources):", error);
    });

    return () => {
      thoughtsUnsubscribe();
      sourcesUnsubscribe();
    };
  }, [user]);

  // --- Daily Selection Logic ---
  useEffect(() => {
    if (!user || thoughts.length === 0) return;

    const today = new Date().toISOString().split('T')[0];
    const selectionRef = doc(db, 'users', user.uid, 'daily_selections', today);

    const checkDailySelection = async () => {
      const selectionSnap = await getDoc(selectionRef);
      
      // Filter thoughts by active sources
      const activeSourceIds = sourceDocuments.filter(s => s.isActive).map(s => s.id);
      const eligibleThoughts = thoughts.filter(t => !t.sourceId || activeSourceIds.includes(t.sourceId));

      if (selectionSnap.exists()) {
        const data = selectionSnap.data() as DailySelection;
        const selected = thoughts.filter(t => data.thoughtIds.includes(t.id));
        setDailyThoughts(selected);
      } else if (eligibleThoughts.length > 0) {
        // Pick 2 random thoughts from eligible ones
        const shuffled = [...eligibleThoughts].sort(() => 0.5 - Math.random());
        const selectedIds = shuffled.slice(0, 2).map(t => t.id);
        
        await setDoc(selectionRef, {
          date: today,
          thoughtIds: selectedIds,
          userId: user.uid
        });
        
        setDailyThoughts(shuffled.slice(0, 2));
      }
    };

    checkDailySelection();
  }, [user, thoughts, sourceDocuments]);

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    provider.addScope('https://www.googleapis.com/auth/drive.readonly');
    provider.setCustomParameters({ prompt: 'consent' });
    setLoginError(null);
    try {
      const result = await signInWithPopup(auth, provider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) {
        setGoogleAccessToken(credential.accessToken);
        localStorage.setItem('google_drive_token', credential.accessToken);
      }
    } catch (error: any) {
      if (error.code === 'auth/popup-closed-by-user') {
        setLoginError("The login window was closed before completion. Please try again and keep the window open.");
      } else if (error.code === 'auth/blocked-at-popup-request') {
        setLoginError("The login popup was blocked by your browser. Please allow popups for this site.");
      } else {
        setLoginError("An error occurred during login. Please try again.");
        console.error("Login/Drive connection failed", error);
      }
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('google_drive_token');
    signOut(auth);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    setIsUploading(true);
    try {
      let extractedThoughts: ExtractedThought[] = [];

      if (file.type === 'application/pdf') {
        const reader = new FileReader();
        const base64Promise = new Promise<string>((resolve) => {
          reader.onload = () => {
            const base64 = (reader.result as string).split(',')[1];
            resolve(base64);
          };
          reader.readAsDataURL(file);
        });
        const base64 = await base64Promise;
        extractedThoughts = await parseThoughtsFromPdf(base64);
      } else if (file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        extractedThoughts = await parseThoughtsFromText(result.value);
      } else {
        // Text or Markdown
        const text = await file.text();
        extractedThoughts = await parseThoughtsFromText(text);
      }
      
      // Create Source Document
      const sourceDocRef = await addDoc(collection(db, 'users', user.uid, 'source_documents'), {
        name: file.name,
        type: 'file',
        isActive: true,
        userId: user.uid,
        createdAt: serverTimestamp()
      });

      const batchPromises = extractedThoughts.map(thought => {
        return addDoc(collection(db, 'users', user.uid, 'thoughts'), {
          content: thought.content,
          source: thought.author || '',
          sourceId: sourceDocRef.id,
          userId: user.uid,
          createdAt: serverTimestamp()
        });
      });

      await Promise.all(batchPromises);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (error) {
      console.error("Upload failed", error);
    } finally {
      setIsUploading(false);
    }
  };

  const handleUrlSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!docUrl || !user) return;

    setIsUploading(true);
    setIsUrlModalOpen(false);
    try {
      let extractedThoughts: ExtractedThought[] = [];
      
      // Check if it's a Google Doc URL
      const googleDocMatch = docUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
      
      if (googleDocMatch && googleAccessToken) {
        const fileId = googleDocMatch[1];
        
        // 1. Try to get file metadata first to verify access and type
        const metaResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=mimeType`, {
          headers: { 'Authorization': `Bearer ${googleAccessToken}` }
        });

        if (!metaResponse.ok) {
          if (metaResponse.status === 401 || metaResponse.status === 403) {
            localStorage.removeItem('google_drive_token');
            setGoogleAccessToken(null);
            throw new Error("Access Denied. When connecting, you MUST check the box that says 'See and download all your Google Drive files'. Please click 'Connect Google Drive' again.");
          }
          throw new Error(`Could not access file (${metaResponse.status}). Ensure you have permission to view this document.`);
        }

        const metadata = await metaResponse.json();
        const isGoogleDoc = metadata.mimeType?.includes('google-apps');

        // 2. Fetch content based on type
        let text = '';
        if (isGoogleDoc) {
          // Export Google Docs as plain text
          const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, {
            headers: { 'Authorization': `Bearer ${googleAccessToken}` }
          });
          if (!response.ok) throw new Error("Failed to export Google Doc content.");
          text = await response.text();
        } else {
          // Download binary files (PDF, etc) directly if possible
          const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
            headers: { 'Authorization': `Bearer ${googleAccessToken}` }
          });
          if (!response.ok) throw new Error("This file type cannot be imported directly. Please use a Google Doc or a public URL.");
          text = await response.text();
        }
        
        extractedThoughts = await parseThoughtsFromText(text);
      } else {
        // Fallback to standard URL context for public URLs
        extractedThoughts = await parseThoughtsFromUrl(docUrl);
      }
      
      // Create Source Document
      const sourceDocRef = await addDoc(collection(db, 'users', user.uid, 'source_documents'), {
        name: docUrl.split('/').pop() || docUrl,
        type: 'url',
        isActive: true,
        userId: user.uid,
        createdAt: serverTimestamp()
      });

      const batchPromises = extractedThoughts.map(thought => {
        return addDoc(collection(db, 'users', user.uid, 'thoughts'), {
          content: thought.content,
          source: thought.author || '',
          sourceId: sourceDocRef.id,
          userId: user.uid,
          createdAt: serverTimestamp()
        });
      });

      await Promise.all(batchPromises);
      setDocUrl('');
    } catch (error) {
      console.error("URL processing failed", error);
    } finally {
      setIsUploading(false);
    }
  };

  const deleteThought = async (id: string) => {
    if (!user) return;
    try {
      await deleteDoc(doc(db, 'users', user.uid, 'thoughts', id));
    } catch (error) {
      console.error("Delete failed", error);
    }
  };

  const refreshDailySelection = async () => {
    if (!user) return;
    
    // Filter thoughts by active sources
    const activeSourceIds = sourceDocuments.filter(s => s.isActive).map(s => s.id);
    const eligibleThoughts = thoughts.filter(t => !t.sourceId || activeSourceIds.includes(t.sourceId));

    if (eligibleThoughts.length < 2) return;

    const today = new Date().toISOString().split('T')[0];
    const selectionRef = doc(db, 'users', user.uid, 'daily_selections', today);
    
    const shuffled = [...eligibleThoughts].sort(() => 0.5 - Math.random());
    const selectedIds = shuffled.slice(0, 2).map(t => t.id);
    
    await setDoc(selectionRef, {
      date: today,
      thoughtIds: selectedIds,
      userId: user.uid
    });
    setDailyThoughts(shuffled.slice(0, 2));
  };

  const toggleDocumentActive = async (docId: string, currentStatus: boolean) => {
    if (!user) return;
    try {
      await setDoc(doc(db, 'users', user.uid, 'source_documents', docId), {
        isActive: !currentStatus
      }, { merge: true });
    } catch (error) {
      console.error("Toggle failed", error);
    }
  };

  const deleteDocument = async (docId: string) => {
    if (!user) return;
    try {
      // 1. Delete the document
      await deleteDoc(doc(db, 'users', user.uid, 'source_documents', docId));
      
      // 2. Delete associated thoughts
      const associatedThoughts = thoughts.filter(t => t.sourceId === docId);
      const deletePromises = associatedThoughts.map(t => deleteDoc(doc(db, 'users', user.uid, 'thoughts', t.id)));
      await Promise.all(deletePromises);
    } catch (error) {
      console.error("Delete document failed", error);
    }
  };

  const removeDuplicates = async () => {
    if (!user || thoughts.length === 0) return;
    
    const seen = new Set<string>();
    const duplicates: string[] = [];
    
    // Sort by date so we keep the oldest one. Handle potential nulls from serverTimestamp
    const sortedThoughts = [...thoughts].sort((a, b) => {
      const timeA = a.createdAt?.toMillis() || Date.now();
      const timeB = b.createdAt?.toMillis() || Date.now();
      return timeA - timeB;
    });
    
    for (const thought of sortedThoughts) {
      const normalizedContent = thought.content.trim().toLowerCase();
      if (seen.has(normalizedContent)) {
        duplicates.push(thought.id);
      } else {
        seen.add(normalizedContent);
      }
    }
    
    if (duplicates.length === 0) {
      setDuplicateCount(0);
      setIsCleanupModalOpen(true);
      return;
    }
    
    setDuplicateCount(duplicates.length);
    setIsCleanupModalOpen(true);
  };

  const confirmCleanup = async () => {
    if (!user || duplicateCount === 0) return;
    
    setIsCleaning(true);
    try {
      const seen = new Set<string>();
      const duplicates: string[] = [];
      const sortedThoughts = [...thoughts].sort((a, b) => {
        const timeA = a.createdAt?.toMillis() || Date.now();
        const timeB = b.createdAt?.toMillis() || Date.now();
        return timeA - timeB;
      });
      
      for (const thought of sortedThoughts) {
        const normalizedContent = thought.content.trim().toLowerCase();
        if (seen.has(normalizedContent)) {
          duplicates.push(thought.id);
        } else {
          seen.add(normalizedContent);
        }
      }

      const deletePromises = duplicates.map(id => deleteDoc(doc(db, 'users', user.uid, 'thoughts', id)));
      await Promise.all(deletePromises);
      setIsCleanupModalOpen(false);
    } catch (error) {
      console.error("Cleanup failed", error);
    } finally {
      setIsCleaning(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50">
        <Loader2 className="w-8 h-8 text-stone-400 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-stone-50 flex flex-col items-center justify-center p-6 text-center">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md"
        >
          <div className="w-20 h-20 bg-white rounded-3xl shadow-sm flex items-center justify-center mx-auto mb-8 border border-stone-200">
            <Quote className="w-10 h-10 text-stone-800" />
          </div>
          <h1 className="text-4xl font-serif italic text-stone-900 mb-4">Daily Wisdom</h1>
          <p className="text-stone-600 mb-10 leading-relaxed">
            Your personal sanctuary for thoughts. Upload your favorite inspirations and receive two daily sparks of wisdom.
          </p>
          <button 
            onClick={handleLogin}
            className="w-full py-4 bg-stone-900 text-white rounded-2xl font-medium hover:bg-stone-800 transition-all shadow-lg shadow-stone-200 flex items-center justify-center gap-3"
          >
            <Sparkles className="w-5 h-5" />
            Begin Your Journey
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-stone-50 text-stone-900 font-sans selection:bg-stone-200">
        {/* Navigation */}
        <nav className="max-w-4xl mx-auto px-6 py-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-white rounded-xl shadow-sm flex items-center justify-center border border-stone-200">
              <Quote className="w-5 h-5 text-stone-800" />
            </div>
            <span className="font-serif italic text-xl">Daily Wisdom</span>
          </div>
          <div className="flex items-center gap-4">
            <button 
              onClick={handleLogout}
              className="p-2 text-stone-400 hover:text-stone-800 transition-colors"
              title="Logout"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </nav>

        <main className="max-w-4xl mx-auto px-6 pb-24">
          {/* Tabs */}
          <div className="flex gap-8 mb-12 border-b border-stone-200">
            <button 
              onClick={() => setView('daily')}
              className={`pb-4 text-sm font-medium transition-all relative ${view === 'daily' ? 'text-stone-900' : 'text-stone-400 hover:text-stone-600'}`}
            >
              Today's Wisdom
              {view === 'daily' && <motion.div layoutId="tab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-stone-900" />}
            </button>
            <button 
              onClick={() => setView('all')}
              className={`pb-4 text-sm font-medium transition-all relative ${view === 'all' ? 'text-stone-900' : 'text-stone-400 hover:text-stone-600'}`}
            >
              Your Collection ({thoughts.length})
              {view === 'all' && <motion.div layoutId="tab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-stone-900" />}
            </button>
            <button 
              onClick={() => setView('sources')}
              className={`pb-4 text-sm font-medium transition-all relative ${view === 'sources' ? 'text-stone-900' : 'text-stone-400 hover:text-stone-600'}`}
            >
              Sources ({sourceDocuments.length})
              {view === 'sources' && <motion.div layoutId="tab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-stone-900" />}
            </button>
          </div>

          <AnimatePresence mode="wait">
            {view === 'daily' ? (
              <motion.div 
                key="daily"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="space-y-8"
              >
                {thoughts.length === 0 ? (
                  <div className="bg-white rounded-3xl p-12 text-center border border-stone-200 shadow-sm">
                    <BookOpen className="w-12 h-12 text-stone-200 mx-auto mb-4" />
                    <h3 className="text-xl font-serif italic mb-2">Your sanctuary is empty</h3>
                    <p className="text-stone-500 mb-8 max-w-xs mx-auto">Upload a document with your favorite thoughts to begin your daily practice.</p>
                    <button 
                      onClick={() => fileInputRef.current?.click()}
                      className="px-8 py-3 bg-stone-900 text-white rounded-xl hover:bg-stone-800 transition-all flex items-center gap-2 mx-auto"
                    >
                      <Upload className="w-4 h-4" />
                      Upload Thoughts
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="grid md:grid-cols-2 gap-8">
                      {dailyThoughts.map((thought, idx) => (
                        <motion.div 
                          key={thought.id}
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: idx * 0.1 }}
                          className="bg-white rounded-3xl p-10 shadow-sm border border-stone-200 flex flex-col justify-between min-h-[320px] relative overflow-hidden group"
                        >
                          <div className="absolute top-0 right-0 p-6 opacity-5 group-hover:opacity-10 transition-opacity">
                            <Quote className="w-24 h-24" />
                          </div>
                          <p className="text-2xl font-serif italic leading-relaxed text-stone-800 relative z-10">
                            "{thought.content}"
                          </p>
                          <div className="mt-8 flex flex-col gap-2 relative z-10">
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-serif italic text-stone-500">
                                {thought.source && `— ${thought.source}`}
                              </span>
                              {thought.sourceId && (
                                <span className="text-[9px] px-2 py-0.5 bg-stone-50 text-stone-400 rounded-full border border-stone-100 uppercase tracking-wider font-bold">
                                  {sourceDocuments.find(s => s.id === thought.sourceId)?.name || 'Source'}
                                </span>
                              )}
                            </div>
                          </div>
                        </motion.div>
                      ))}
                    </div>
                    
                    <div className="flex justify-center pt-8">
                      <button 
                        onClick={refreshDailySelection}
                        className="flex items-center gap-2 text-stone-400 hover:text-stone-800 transition-colors text-sm font-medium"
                      >
                        <RefreshCw className="w-4 h-4" />
                        Refresh Today's Selection
                      </button>
                    </div>
                  </>
                )}
              </motion.div>
            ) : view === 'all' ? (
              <motion.div 
                key="all"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-6"
              >
                <div className="flex items-center justify-between mb-8">
                  <h2 className="text-2xl font-serif italic">All Thoughts</h2>
                  <div className="flex gap-2">
                    {thoughts.length > 0 && (
                      <button 
                        onClick={removeDuplicates}
                        className="flex items-center gap-2 px-3 py-2 bg-stone-100 text-stone-500 rounded-xl hover:bg-stone-200 transition-all text-xs font-medium"
                        title="Clean Duplicates"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Clean
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid gap-4">
                  {thoughts.map((thought) => (
                    <div 
                      key={thought.id}
                      className="bg-white p-6 rounded-2xl border border-stone-100 flex items-start justify-between group hover:border-stone-200 transition-all shadow-sm hover:shadow-md"
                    >
                      <div className="flex-1 pr-8">
                        <p className="text-stone-800 leading-relaxed mb-3">{thought.content}</p>
                        <div className="flex items-center gap-3">
                          {thought.source && (
                            <div className="flex items-center gap-2">
                              <div className="w-4 h-px bg-stone-200" />
                              <p className="text-xs italic text-stone-400 font-serif">{thought.source}</p>
                            </div>
                          )}
                          {thought.sourceId && (
                            <span className="text-[9px] px-2 py-0.5 bg-stone-50 text-stone-400 rounded-full border border-stone-100 uppercase tracking-wider font-bold">
                              {sourceDocuments.find(s => s.id === thought.sourceId)?.name || 'Unknown Source'}
                            </span>
                          )}
                        </div>
                      </div>
                      <button 
                        onClick={() => deleteThought(thought.id)}
                        className="p-2 text-stone-200 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </motion.div>
            ) : (
              <motion.div 
                key="sources"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-6"
              >
                <div className="flex items-center justify-between mb-8">
                  <h2 className="text-2xl font-serif italic">Source Documents</h2>
                  <div className="flex gap-2">
                    <button 
                      onClick={() => setIsUrlModalOpen(true)}
                      disabled={isUploading}
                      className="flex items-center gap-2 px-4 py-2 bg-stone-100 text-stone-800 rounded-xl hover:bg-stone-200 transition-all text-sm font-medium disabled:opacity-50"
                    >
                      <LinkIcon className="w-4 h-4" />
                      Import URL
                    </button>
                    <button 
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isUploading}
                      className="flex items-center gap-2 px-4 py-2 bg-stone-900 text-white rounded-xl hover:bg-stone-800 transition-all text-sm font-medium disabled:opacity-50"
                    >
                      {isUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                      Add File
                    </button>
                  </div>
                </div>

                <div className="grid gap-4">
                  {sourceDocuments.length === 0 ? (
                    <div className="bg-white rounded-3xl p-12 text-center border border-stone-200 shadow-sm">
                      <BookOpen className="w-12 h-12 text-stone-200 mx-auto mb-4" />
                      <p className="text-stone-500">No source documents yet.</p>
                    </div>
                  ) : (
                    sourceDocuments.map((doc) => (
                      <div 
                        key={doc.id}
                        className="bg-white p-6 rounded-2xl border border-stone-100 flex items-center justify-between group hover:border-stone-200 transition-all shadow-sm"
                      >
                        <div className="flex items-center gap-4 flex-1">
                          <button 
                            onClick={() => toggleDocumentActive(doc.id, doc.isActive)}
                            className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all border ${
                              doc.isActive 
                                ? 'bg-emerald-50 border-emerald-100 text-emerald-600' 
                                : 'bg-stone-50 border-stone-100 text-stone-300'
                            }`}
                          >
                            <Sparkles className={`w-5 h-5 ${doc.isActive ? 'animate-pulse' : ''}`} />
                          </button>
                          <div>
                            <h4 className={`font-medium transition-colors ${doc.isActive ? 'text-stone-800' : 'text-stone-400 line-through'}`}>
                              {doc.name}
                            </h4>
                            <p className="text-[10px] text-stone-400 uppercase tracking-widest font-bold mt-1">
                              {doc.type} • {thoughts.filter(t => t.sourceId === doc.id).length} thoughts
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded-md ${
                            doc.isActive ? 'text-emerald-600 bg-emerald-50' : 'text-stone-400 bg-stone-50'
                          }`}>
                            {doc.isActive ? 'Active' : 'Inactive'}
                          </span>
                          <button 
                            onClick={() => deleteDocument(doc.id)}
                            className="p-2 text-stone-200 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        {/* Cleanup Modal */}
        <AnimatePresence>
          {isCleanupModalOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setIsCleanupModalOpen(false)}
                className="absolute inset-0 bg-stone-900/40 backdrop-blur-sm"
              />
              <motion.div 
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                className="relative w-full max-w-sm bg-white rounded-3xl p-8 shadow-2xl border border-stone-200 text-center"
              >
                <div className="w-16 h-16 bg-stone-50 rounded-2xl flex items-center justify-center mx-auto mb-6">
                  <RefreshCw className={`w-8 h-8 text-stone-400 ${isCleaning ? 'animate-spin' : ''}`} />
                </div>
                
                {duplicateCount > 0 ? (
                  <>
                    <h3 className="text-xl font-serif italic mb-2">Duplicates Found</h3>
                    <p className="text-sm text-stone-500 mb-8">
                      We found <span className="font-bold text-stone-800">{duplicateCount}</span> duplicate thoughts in your collection. Would you like to remove them?
                    </p>
                    <div className="flex gap-3">
                      <button 
                        onClick={() => setIsCleanupModalOpen(false)}
                        className="flex-1 py-3 bg-stone-100 text-stone-600 rounded-xl font-medium hover:bg-stone-200 transition-all"
                      >
                        Cancel
                      </button>
                      <button 
                        onClick={confirmCleanup}
                        disabled={isCleaning}
                        className="flex-1 py-3 bg-stone-900 text-white rounded-xl font-medium hover:bg-stone-800 transition-all disabled:opacity-50"
                      >
                        {isCleaning ? 'Cleaning...' : 'Remove All'}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <h3 className="text-xl font-serif italic mb-2">Collection is Clean</h3>
                    <p className="text-sm text-stone-500 mb-8">
                      No duplicate thoughts were found in your sanctuary.
                    </p>
                    <button 
                      onClick={() => setIsCleanupModalOpen(false)}
                      className="w-full py-3 bg-stone-900 text-white rounded-xl font-medium hover:bg-stone-800 transition-all"
                    >
                      Great
                    </button>
                  </>
                )}
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* URL Import Modal */}
        <AnimatePresence>
          {isUrlModalOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setIsUrlModalOpen(false)}
                className="absolute inset-0 bg-stone-900/40 backdrop-blur-sm"
              />
              <motion.div 
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                className="relative w-full max-w-md bg-white rounded-3xl p-8 shadow-2xl border border-stone-200"
              >
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-xl font-serif italic">Import from URL</h3>
                  <button onClick={() => setIsUrlModalOpen(false)} className="text-stone-400 hover:text-stone-800">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <p className="text-sm text-stone-500 mb-6">
                  Paste a link to a Google Doc or any web page. If it's a private Google Doc, ensure you've connected your Drive.
                </p>
                {!googleAccessToken ? (
                  <div className="mb-6 p-4 bg-amber-50 border border-amber-100 rounded-xl">
                    <p className="text-xs text-amber-800 mb-3">
                      To import private Google Docs, we need your permission to read your Drive files.
                    </p>
                    <p className="text-[9px] text-amber-700 mb-3 uppercase tracking-tighter font-bold">
                      ⚠️ Important: Check the "See and download all your Google Drive files" box in the popup.
                    </p>
                    {loginError && (
                      <p className="text-[10px] text-red-600 mb-3 font-medium bg-red-50 p-2 rounded-lg border border-red-100">
                        {loginError}
                      </p>
                    )}
                    <button 
                      type="button"
                      onClick={handleLogin}
                      className="text-xs font-bold text-amber-900 underline hover:no-underline flex items-center gap-2"
                    >
                      <Sparkles className="w-3 h-3" />
                      Connect Google Drive
                    </button>
                  </div>
                ) : (
                  <div className="mb-6 flex flex-col gap-2">
                    <div className="flex justify-between items-center px-1">
                      <span className="text-[10px] text-emerald-600 font-bold uppercase tracking-wider flex items-center gap-1">
                        <div className="w-1 h-1 bg-emerald-500 rounded-full animate-pulse" />
                        Drive Connected
                      </span>
                      <button 
                        type="button"
                        onClick={handleLogin}
                        className="text-[10px] text-stone-400 hover:text-stone-800 underline"
                      >
                        Refresh Connection
                      </button>
                    </div>
                    {loginError && (
                      <p className="text-[10px] text-red-600 font-medium bg-red-50 p-2 rounded-lg border border-red-100">
                        {loginError}
                      </p>
                    )}
                  </div>
                )}
                <form onSubmit={handleUrlSubmit} className="space-y-4">
                  <input 
                    type="url" 
                    required
                    placeholder="https://docs.google.com/document/d/..."
                    value={docUrl}
                    onChange={(e) => setDocUrl(e.target.value)}
                    className="w-full px-4 py-3 bg-stone-50 border border-stone-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-stone-200 transition-all"
                  />
                  <button 
                    type="submit"
                    className="w-full py-3 bg-stone-900 text-white rounded-xl font-medium hover:bg-stone-800 transition-all"
                  >
                    Extract Wisdom
                  </button>
                </form>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Hidden File Input */}
        <input 
          type="file" 
          ref={fileInputRef}
          onChange={handleFileUpload}
          accept=".txt,.md,.pdf,.docx"
          className="hidden"
        />

        {/* Footer Info */}
        <footer className="fixed bottom-0 left-0 right-0 bg-stone-50/80 backdrop-blur-md border-t border-stone-200 py-4">
          <div className="max-w-4xl mx-auto px-6 flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-stone-400 font-bold">
            <span>Daily Wisdom v1.0</span>
            <span>{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</span>
          </div>
        </footer>
      </div>
    </ErrorBoundary>
  );
}
