import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    // Remove console.error
  }, [location.pathname]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-4">404</h1>
        <p className="text-xl text-gray-600 mb-4">Oops! The road you are looking for hasn't been found yet. .</p>
        <Link to="/" className="text-blue-500 hover:text-blue-700 underline">
          Come back home 
        </Link>
      </div>
    </div>
  );
};

export default NotFound;
