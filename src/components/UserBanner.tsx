import React, { useCallback, useState } from 'react';
import { locationService } from '../services';
import MenuBtnsPopup from './MenuBtnsPopup';
import '../less/user-banner.less';
import { UserName } from '../memos';
import More from '../icons/more.svg?react';

interface Props {}

const UserBanner: React.FC<Props> = () => {
  const username = UserName;
  const [shouldShowPopupBtns, setShouldShowPopupBtns] = useState(false);

  const handleUsernameClick = useCallback(() => {
    locationService.pushHistory('/');
    locationService.clearQuery();
  }, []);

  const handlePopupBtnClick = () => {
    const sidebarEl = document.querySelector('.memos-sidebar-wrapper') as HTMLElement;
    const popupEl = document.querySelector('.menu-btns-popup') as HTMLElement;
    popupEl.style.top = 70 - sidebarEl.scrollTop + 'px';
    setShouldShowPopupBtns(true);
  };

  return (
    <div className="user-banner-container">
      <div className="userinfo-header-container">
        <p className="username-text" onClick={handleUsernameClick}>
          {username}
        </p>
        <span className="action-btn menu-popup-btn" onClick={handlePopupBtnClick}>
          {/*<img src={more} className="icon-img" />*/}
          <More className="icon-img" />
        </span>
        <MenuBtnsPopup shownStatus={shouldShowPopupBtns} setShownStatus={setShouldShowPopupBtns} />
      </div>
    </div>
  );
};

export default UserBanner;
