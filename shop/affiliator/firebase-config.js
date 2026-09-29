import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCptCZvEL_rmxrRr3Rxjr_-FLb251jQd8nI",
  authDomain: "dicidy.firebaseapp.com",
  projectId: "dicidy",
  storageBucket: "dicidy.firebasestorage.app",
  messagingSenderId: "267650575298",
  appId: "1:267650575298:web:afc3757a495a043846045b"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { app, auth, db };
