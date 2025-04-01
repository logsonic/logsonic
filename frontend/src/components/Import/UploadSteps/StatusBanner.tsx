import { AlertTriangle, CheckCircle, X } from 'lucide-react';
import { FC } from 'react';
interface StatusBannerProps {
  type: 'success' | 'error' | 'warning';
  title: string;
  message?: string;
  onClose: () => void;
}

export const StatusBanner: FC<StatusBannerProps> = ({
  type,
  title,
  message,
  onClose
}) => {
  const styles = {
    success: {
      bg: 'bg-green-50',
      text: 'text-green-700',
      icon: <CheckCircle className="h-5 w-5 mr-2 text-green-600" />,
      hover: 'hover:bg-green-100'
    },
    error: {
      bg: 'bg-red-50',
      text: 'text-red-600',
      icon: <AlertTriangle className="h-5 w-5 mr-2" />,
      hover: 'hover:bg-red-100'
    },
    warning: {
      bg: 'bg-yellow-50',
      text: 'text-yellow-700',
      icon: <AlertTriangle className="h-5 w-5 mr-2 text-yellow-600" />,
      hover: 'hover:bg-yellow-100'
    }
  };

  const style = styles[type];

  return (
    <div className={`${style.bg} ${style.text} p-4 rounded-md text-base shadow-sm relative`}>
      <button 
        onClick={onClose} 
        className={`absolute top-2 right-2 p-1 ${style.hover} rounded-full`}
        aria-label="Close"
      >
        <X className="h-4 w-4" />
      </button>
      <div className="flex items-center mb-1">
        {style.icon}
        <p className="font-semibold">{title}</p>
      </div>
      {message && <p>{message}</p>}
    </div>
  );
};

export default StatusBanner; 