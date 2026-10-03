import React, { useCallback } from 'react';
import { locationService } from '../services';
import '../less/user-banner.less';
import { UserName } from '../memos';

interface Props {}

const UserBanner: React.FC<Props> = () => {
  const username = UserName;

  const handleUsernameClick = useCallback(() => {
    locationService.pushHistory('/');
    locationService.clearQuery();
  }, []);

  return (
    <div className="user-banner-container">
      <div className="userinfo-header-container">
        <p className="username-text" onClick={handleUsernameClick}>
          {username}
        </p>
      </div>
    </div>
  );
};

export default UserBanner;
