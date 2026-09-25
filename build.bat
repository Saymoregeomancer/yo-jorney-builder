@echo off
rem Збирає dist\YoJourneyBuilder.exe
cd /d "%~dp0"
python -m pip install -r requirements.txt || exit /b 1
python -m PyInstaller --noconfirm --clean YoJourneyBuilder.spec || exit /b 1
echo.
echo Готово: dist\YoJourneyBuilder.exe
