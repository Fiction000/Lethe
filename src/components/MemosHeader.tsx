import React, { useCallback, useContext } from 'react';
import appContext from '../stores/appContext';
import SearchBar from './SearchBar';
import { globalStateService, memoService } from '../services';
import Only from './common/OnlyWhen';
import '../less/memos-header.less';
import MenuSvg from '../icons/menu.svg?react';

interface Props {}

const MemosHeader: React.FC<Props> = () => {
  const {
    globalState: { isMobileView },
  } = useContext(appContext);

  const handleMemoTextClick = useCallback(() => {
    // Force refresh when user clicks header
    memoService.fetchAllMemos(true).catch(() => {
      // do nth
    });
  }, []);

  // const handleRefreshClick = useCallback(() => {
  //   memoService.fetchAllMemos().catch(() => {
  //     // do nth
  //   });
  // }, []);

  const handleShowSidebarBtnClick = useCallback(() => {
    globalStateService.setShowSiderbarInMobileView(true);
  }, []);

  return (
    <div className="section-header-container memos-header-container">
      <div className="title-text" onClick={handleMemoTextClick}>
        <Only when={isMobileView}>
          <button className="action-btn" onClick={handleShowSidebarBtnClick}>
            {/*<img className="icon-img" src={menuSvg} alt="menu" />*/}
            <MenuSvg className="icon-img" />
          </button>
        </Only>
        <span className="normal-text">MEMOS</span>
        {/*<span className="refresh-icon" onClick={handleRefreshClick}>*/}
        {/*  🔄*/}
        {/*</span>*/}
      </div>
      <SearchBar />
    </div>
  );
};

export default MemosHeader;
